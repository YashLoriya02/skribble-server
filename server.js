const { Server } = require("socket.io");
const io = new Server(5000, { cors: { origin: "*" } });

const rooms = new Map();

function mask(word) { return word.split("").map(ch => ch === " " ? " " : "_"); }
const WORDS = ["apple", "bridge", "rocket", "guitar", "elephant", "butterfly", "mountain", "rainbow", "pizza", "camera"];

io.on("connection", (sock) => {
    let currentRoom = null, me = null;

    function broadcastState() {
        const r = rooms.get(currentRoom);
        const payload = {
            code: currentRoom,
            players: r.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
            me: { id: me.id, name: me.name, score: me.score },
            drawerId: r.drawerId || null,
            word: (r.drawerId === me.id) ? r.word : null,
            maskedWord: r.maskedWord,
            round: r.round, totalRounds: r.totalRounds, timeLeft: r.timeLeft
        };
        io.to(currentRoom).emit("room:state", payload);
        if (r.started) io.to(currentRoom).emit("game:state", payload);
    }

    sock.on("room:create", ({ name }) => {
        const code = Math.random().toString(36).slice(2, 6).toUpperCase();
        const player = { id: sock.id, name, score: 0 };
        rooms.set(code, { players: [player], started: false, round: 1, totalRounds: 3, timeLeft: 0 });
        sock.join(code);
        currentRoom = code; me = player;
        sock.emit("room:created", { code, players: [player], me: player, round: 1, totalRounds: 3, timeLeft: 0, maskedWord: [] });
        broadcastState();
    });

    sock.on("room:join", ({ code, name }) => {
        const r = rooms.get(code);
        if (!r) return sock.emit("error:toast", "Room not found");
        const player = { id: sock.id, name, score: 0 };
        r.players.push(player);
        sock.join(code);
        currentRoom = code; me = player;
        sock.emit("room:joined", { code, players: r.players, me: player, round: r.round, totalRounds: r.totalRounds, timeLeft: r.timeLeft, maskedWord: r.maskedWord || [] });
        broadcastState();
    });

    sock.on("game:start", ({ roundsEach, secondsPerRound }) => {
        const r = rooms.get(currentRoom); if (!r) return;
        r.totalRounds = roundsEach;
        r.secondsPerRound = secondsPerRound;
        r.started = true;
        r.turnIndex = 0;
        nextTurn(r);
    });

    function nextTurn(r) {
        const order = r.order || buildOrder(r.players, r.totalRounds);
        r.order = order;
        const drawer = order[r.turnIndex % order.length];
        r.drawerId = drawer.id;
        r.word = WORDS[Math.floor(Math.random() * WORDS.length)];
        r.maskedWord = mask(r.word);
        r.timeLeft = r.secondsPerRound;
        io.to(currentRoom).emit("game:beginClient", pack(r));
        tick(r);
    }

    function pack(r) {
        return {
            code: currentRoom,
            players: r.players,
            me: { id: me.id, name: me.name, score: me.score },
            drawerId: r.drawerId,
            word: (r.drawerId === me.id) ? r.word : null,
            maskedWord: r.maskedWord,
            round: Math.floor(r.turnIndex / r.players.length) + 1,
            totalRounds: r.totalRounds,
            timeLeft: r.timeLeft
        };
    }

    function buildOrder(players, rounds) {
        const arr = []; for (let i = 0; i < rounds; i++) { const s = [...players].sort(() => Math.random() - 0.5); arr.push(...s); }
        return arr;
    }

    function tick(r) {
        clearInterval(r._intv);
        r._intv = setInterval(() => {
            r.timeLeft -= 1;
            io.to(currentRoom).emit("timer:tick", r.timeLeft);
            if (r.timeLeft <= 0) { clearInterval(r._intv); r.turnIndex = (r.turnIndex + 1); io.to(currentRoom).emit("chat:new", `⏱️ Time up! Word was: ${r.word}`); nextTurn(r); }
        }, 1000);
    }

    // Drawing relay
    sock.on("draw:start", d => { io.to(currentRoom).emit("draw:start", d); });
    sock.on("draw:move", d => { io.to(currentRoom).emit("draw:move", d); });
    sock.on("draw:clear", () => { io.to(currentRoom).emit("draw:clear"); });

    // Guesses
    sock.on("guess:new", text => {
        const r = rooms.get(currentRoom); if (!r) return;
        const p = r.players.find(x => x.id === sock.id);
        io.to(currentRoom).emit("chat:new", `${p?.name || 'Player'}: ${text}`);
        if (text.trim().toLowerCase() === r.word.toLowerCase()) {
            const guesser = p; const drawer = r.players.find(x => x.id === r.drawerId);
            if (guesser) guesser.score += Math.max(100, r.timeLeft * 10);
            if (drawer) drawer.score += 50;
            io.to(currentRoom).emit("guess:correct", { by: guesser?.name, word: r.word });
            clearInterval(r._intv);
            r.turnIndex = (r.turnIndex + 1);
            nextTurn(r);
        }
    });

    sock.on("disconnect", () => { /* keep it simple for now */ });
});
