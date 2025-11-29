const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'OK',
            message: '♟️ Chess Without Borders Federation Server',
            timestamp: new Date().toISOString(),
            online: connections.size,
            users: users.size,
            games: games.size
        }));
        return;
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false
});

// Хранилища
const users = new Map();
const games = new Map();
const challenges = new Map();
const connections = new Map();

wss.on('connection', (ws, req) => {
    const connectionId = uuidv4();
    const clientIP = req.socket.remoteAddress;
    
    connections.set(connectionId, ws);
    console.log('🔗 Новое подключение:', connectionId, 'IP:', clientIP);

    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Добро пожаловать в Федерацию Шахматы без границ',
        connectionId: connectionId,
        serverTime: new Date().toISOString()
    }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(connectionId, message);
        } catch (error) {
            console.error('❌ Ошибка парсинга:', error);
            sendToConnection(connectionId, {
                type: 'error',
                message: 'Неверный формат JSON'
            });
        }
    });

    ws.on('close', () => {
        console.log('🔌 Отключение:', connectionId);
        connections.delete(connectionId);
        
        // Помечаем пользователя офлайн
        for (let [email, user] of users) {
            if (user.connectionId === connectionId) {
                user.isOnline = false;
                user.lastSeen = new Date();
                broadcast({
                    type: 'user_offline',
                    email: email
                });
                break;
            }
        }
        
        broadcastOnlineUsers();
    });

    ws.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
});

function handleMessage(connectionId, message) {
    switch (message.type) {
        case 'ping':
            sendToConnection(connectionId, { 
                type: 'pong', 
                serverTime: new Date().toISOString() 
            });
            break;
            
        case 'register':
            handleRegister(connectionId, message);
            break;
            
        case 'login':
            handleLogin(connectionId, message);
            break;
            
        case 'get_online_users':
            handleGetOnlineUsers(connectionId);
            break;
            
        case 'create_challenge':
            handleCreateChallenge(connectionId, message);
            break;
            
        case 'accept_challenge':
            handleAcceptChallenge(connectionId, message);
            break;

        case 'make_move':
            handleMakeMove(connectionId, message);
            break;
            
        default:
            sendToConnection(connectionId, {
                type: 'error',
                message: `Неизвестная команда: ${message.type}`
            });
    }
}

function handleRegister(connectionId, data) {
    const { email, nickname } = data;
    
    if (!email) {
        sendToConnection(connectionId, {
            type: 'register_response',
            success: false,
            message: 'Email обязателен'
        });
        return;
    }

    const user = {
        id: uuidv4(),
        email: email,
        nickname: nickname || email.split('@')[0],
        playerRank: 'Без разряда',
        isOnline: true,
        connectionId: connectionId,
        lastSeen: new Date(),
        stats: {
            totalGames: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            points: 0
        }
    };
    
    users.set(email, user);
    
    sendToConnection(connectionId, {
        type: 'register_response',
        success: true,
        user: user
    });
    
    broadcastOnlineUsers();
}

function handleLogin(connectionId, data) {
    const { email } = data;
    
    let user = users.get(email);
    if (!user) {
        user = {
            id: uuidv4(),
            email: email,
            nickname: email.split('@')[0],
            playerRank: 'Без разряда',
            isOnline: true,
            connectionId: connectionId,
            lastSeen: new Date(),
            stats: {
                totalGames: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                points: 0
            }
        };
        users.set(email, user);
    } else {
        user.isOnline = true;
        user.connectionId = connectionId;
        user.lastSeen = new Date();
    }
    
    sendToConnection(connectionId, {
        type: 'login_response',
        success: true,
        user: user
    });
    
    broadcastOnlineUsers();
}

function handleGetOnlineUsers(connectionId) {
    const onlineUsers = Array.from(users.values())
        .filter(user => user.isOnline)
        .map(user => ({
            email: user.email,
            nickname: user.nickname,
            playerRank: user.playerRank,
            stats: user.stats
        }));
    
    sendToConnection(connectionId, {
        type: 'online_users',
        users: onlineUsers
    });
}

function handleCreateChallenge(connectionId, data) {
    const user = getUserByConnectionId(connectionId);
    if (!user) {
        sendToConnection(connectionId, {
            type: 'error',
            message: 'Требуется авторизация'
        });
        return;
    }

    const challenge = {
        id: uuidv4(),
        creator: user.email,
        creatorNickname: user.nickname,
        opponent: data.opponent,
        timeControl: data.timeControl,
        type: data.type || 'personal',
        status: 'pending',
        createdAt: new Date()
    };
    
    challenges.set(challenge.id, challenge);
    
    sendToConnection(connectionId, {
        type: 'challenge_created',
        challenge: challenge
    });
    
    // Уведомляем оппонента если указан
    if (data.opponent) {
        const opponent = users.get(data.opponent);
        if (opponent && opponent.isOnline) {
            sendToConnection(opponent.connectionId, {
                type: 'new_challenge',
                challenge: challenge
            });
        }
    } else {
        // Открытый вызов - уведомляем всех
        broadcast({
            type: 'open_challenge',
            challenge: challenge
        }, user.email);
    }
}

function handleAcceptChallenge(connectionId, data) {
    const user = getUserByConnectionId(connectionId);
    const challenge = challenges.get(data.challengeId);
    
    if (!challenge) {
        sendToConnection(connectionId, {
            type: 'error',
            message: 'Вызов не найден'
        });
        return;
    }
    
    challenge.status = 'accepted';
    
    const game = {
        id: uuidv4(),
        whitePlayer: challenge.creator,
        blackPlayer: user.email,
        whiteNickname: challenge.creatorNickname,
        blackNickname: user.nickname,
        timeControl: challenge.timeControl,
        board: [
            ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
            ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
            ['', '', '', '', '', '', '', ''],
            ['', '', '', '', '', '', '', ''],
            ['', '', '', '', '', '', '', ''],
            ['', '', '', '', '', '', '', ''],
            ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
            ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
        ],
        currentPlayer: 'white',
        status: 'active',
        createdAt: new Date(),
        moveHistory: []
    };
    
    games.set(game.id, game);
    challenges.delete(challenge.id);
    
    // Уведомляем обоих игроков
    const creator = users.get(challenge.creator);
    if (creator && creator.isOnline) {
        sendToConnection(creator.connectionId, {
            type: 'challenge_accepted',
            game: game,
            opponent: user
        });
    }
    
    sendToConnection(connectionId, {
        type: 'challenge_accepted', 
        game: game,
        opponent: creator
    });
    
    console.log('🎮 Начата игра:', game.id);
}

function handleMakeMove(connectionId, data) {
    const user = getUserByConnectionId(connectionId);
    const game = games.get(data.gameId);
    
    if (!game) {
        sendToConnection(connectionId, {
            type: 'error',
            message: 'Игра не найдена'
        });
        return;
    }
    
    // Проверяем, что ход делает текущий игрок
    const currentPlayerEmail = game.currentPlayer === 'white' ? game.whitePlayer : game.blackPlayer;
    if (user.email !== currentPlayerEmail) {
        sendToConnection(connectionId, {
            type: 'error',
            message: 'Сейчас не ваш ход'
        });
        return;
    }
    
    // Простая логика хода (без проверки правил)
    const { fromRow, fromCol, toRow, toCol, promotion } = data;
    
    // Сохраняем ход в историю
    game.moveHistory.push({
        from: { row: fromRow, col: fromCol },
        to: { row: toRow, col: toCol },
        promotion: promotion,
        player: user.email,
        timestamp: new Date()
    });
    
    // Обновляем доску
    const piece = game.board[fromRow][fromCol];
    game.board[toRow][toCol] = promotion || piece;
    game.board[fromRow][fromCol] = '';
    
    // Меняем игрока
    game.currentPlayer = game.currentPlayer === 'white' ? 'black' : 'white';
    
    // Уведомляем оппонента
    const opponentEmail = game.currentPlayer === 'white' ? game.blackPlayer : game.whitePlayer;
    const opponent = users.get(opponentEmail);
    
    if (opponent && opponent.isOnline) {
        sendToConnection(opponent.connectionId, {
            type: 'opponent_move',
            gameId: game.id,
            move: {
                from: { row: fromRow, col: fromCol },
                to: { row: toRow, col: toCol },
                promotion: promotion
            },
            board: game.board,
            currentPlayer: game.currentPlayer
        });
    }
    
    sendToConnection(connectionId, {
        type: 'move_accepted',
        gameId: game.id,
        board: game.board,
        currentPlayer: game.currentPlayer
    });
    
    console.log(`♟️ Ход в игре ${game.id}: ${user.email}`);
}

function getUserByConnectionId(connectionId) {
    for (let [email, user] of users) {
        if (user.connectionId === connectionId) {
            return user;
        }
    }
    return null;
}

function sendToConnection(connectionId, message) {
    const ws = connections.get(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(message));
        } catch (error) {
            console.error('❌ Ошибка отправки:', error);
        }
    }
}

function broadcast(message, excludeEmail = null) {
    connections.forEach((ws, connectionId) => {
        if (excludeEmail) {
            const user = getUserByConnectionId(connectionId);
            if (user && user.email === excludeEmail) return;
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('❌ Ошибка широковещательной отправки:', error);
            }
        }
    });
}

function broadcastOnlineUsers() {
    const onlineUsers = Array.from(users.values())
        .filter(user => user.isOnline)
        .map(user => ({
            email: user.email,
            nickname: user.nickname,
            playerRank: user.playerRank
        }));
    
    broadcast({
        type: 'online_users_update',
        users: onlineUsers
    });
}

// Очистка старых данных каждые 30 минут
setInterval(() => {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // Удаляем старые завершенные игры
    for (let [id, game] of games) {
        if (!game.status === 'active' && game.createdAt < hourAgo) {
            games.delete(id);
            console.log('🗑️ Удалена старая игра:', id);
        }
    }
    
    // Удаляем старые вызовы
    for (let [id, challenge] of challenges) {
        if (challenge.status !== 'pending' && challenge.createdAt < hourAgo) {
            challenges.delete(id);
            console.log('🗑️ Удален старый вызов:', id);
        }
    }
    
    console.log('📊 Статистика сервера:', {
        users: users.size,
        online: Array.from(users.values()).filter(u => u.isOnline).length,
        games: games.size,
        challenges: challenges.size,
        connections: connections.size
    });
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🎉 ♟️ Федерация Шахматы без границ - Сервер запущен!
📍 Порт: ${PORT}
📍 Health: http://localhost:${PORT}/health
⏰ Время: ${new Date().toISOString()}
    `);
});
