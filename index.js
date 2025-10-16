const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*" }
});

const rooms = new Map();
const WORDS = ["apple", "bridge", "rocket", "guitar", "elephant", "butterfly", "mountain", "rainbow", "pizza", "camera"];
const mask = (word) => word.split("").map(ch => (ch === " " ? " " : "_"));

app.get("/", (_, res) => res.json({ status: "Healthy", success: true }));

io.on("connection", (sock) => {
    let currentRoom = null;
    let me = null;

    const broadcastState = () => {
        const r = rooms.get(currentRoom);
        if (!r) return;
        const payload = {
            code: currentRoom,
            players: r.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
            me: { id: me.id, name: me.name, score: me.score },
            drawerId: r.drawerId || null,
            word: r.drawerId === me.id ? r.word : null,
            maskedWord: r.maskedWord || [],
            round: r.round,
            totalRounds: r.totalRounds,
            timeLeft: r.timeLeft
        };
        io.to(currentRoom).emit("room:state", payload);
        if (r.started) io.to(currentRoom).emit("game:state", payload);
    };

    sock.on("room:create", ({ name }) => {
        const code = Math.random().toString(36).slice(2, 6).toUpperCase();
        const player = { id: sock.id, name, score: 0 };
        rooms.set(code, {
            players: [player],
            started: false,
            round: 1,
            totalRounds: 3,
            timeLeft: 0,
            order: [],
            secondsPerRound: 75,
            _intv: null
        });
        sock.join(code);
        currentRoom = code;
        me = player;
        sock.emit("room:created", {
            code,
            players: [player],
            me: player,
            round: 1,
            totalRounds: 3,
            timeLeft: 0,
            maskedWord: []
        });
        broadcastState();
    });

    sock.on("room:join", ({ code, name }) => {
        const r = rooms.get(code);
        if (!r) return sock.emit("error:toast", "Room not found");
        const player = { id: sock.id, name, score: 0 };
        r.players.push(player);
        sock.join(code);
        currentRoom = code;
        me = player;
        sock.emit("room:joined", {
            code,
            players: r.players,
            me: player,
            round: r.round,
            totalRounds: r.totalRounds,
            timeLeft: r.timeLeft,
            maskedWord: r.maskedWord || []
        });
        broadcastState();
    });

    sock.on("game:start", ({ roundsEach, secondsPerRound }) => {
        const r = rooms.get(currentRoom);
        if (!r) return;
        r.totalRounds = roundsEach;
        r.secondsPerRound = secondsPerRound;
        r.started = true;
        r.round = 1;
        r.turnIndex = 0;
        r.order = buildOrder(r.players, r.totalRounds);
        nextTurn(r);
    });

    sock.on("draw:start", (d) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit("draw:start", d);
    });
    sock.on("draw:move", (d) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit("draw:move", d);
    });
    sock.on("draw:clear", () => {
        if (!currentRoom) return;
        io.to(currentRoom).emit("draw:clear");
    });

    sock.on("guess:new", (text) => {
        const r = rooms.get(currentRoom);
        if (!r) return;
        const p = r.players.find(x => x.id === sock.id);
        io.to(currentRoom).emit("chat:new", `${p?.name || "Player"}: ${text}`);
        if (text.trim().toLowerCase() === r.word.toLowerCase()) {
            const guesser = p;
            const drawer = r.players.find(x => x.id === r.drawerId);
            if (guesser) guesser.score += Math.max(100, r.timeLeft * 10);
            if (drawer) drawer.score += 50;
            io.to(currentRoom).emit("guess:correct", { by: guesser?.name, word: r.word });
            clearInterval(r._intv);
            r.turnIndex += 1;
            updateRound(r);
            nextTurn(r);
        }
    });

    sock.on("disconnect", () => {
        if (!currentRoom) return;
        const r = rooms.get(currentRoom);
        if (!r) return;
        r.players = r.players.filter(p => p.id !== sock.id);

        if (r.drawerId === sock.id && r.started) {
            clearInterval(r._intv);
            r.turnIndex += 1;
            updateRound(r);
            if (r.players.length >= 2) nextTurn(r);
        }

        if (r.players.length === 0) {
            clearInterval(r._intv);
            rooms.delete(currentRoom);
            return;
        }
        broadcastState();
    });

    // Helpers
    function buildOrder(players, rounds) {
        const arr = [];
        for (let i = 0; i < rounds; i++) {
            const s = [...players].sort(() => Math.random() - 0.5);
            arr.push(...s);
        }
        return arr;
    }

    function updateRound(r) {
        r.round = Math.floor(r.turnIndex / Math.max(1, r.players.length)) + 1;
        if (r.round > r.totalRounds) {
            clearInterval(r._intv);
            io.to(currentRoom).emit("chat:new", "🎉 Game over!");
            r.started = false;
        }
    }

    function nextTurn(r) {
        if (!r.started) return;
        const order = r.order.length ? r.order : buildOrder(r.players, r.totalRounds);
        r.order = order;
        const drawer = order[r.turnIndex % order.length];
        r.drawerId = drawer?.id;

        if (!r.players.find(p => p.id === r.drawerId)) {
            r.turnIndex += 1;
            updateRound(r);
            return nextTurn(r);
        }

        r.word = WORDS[Math.floor(Math.random() * WORDS.length)];
        r.maskedWord = mask(r.word);
        r.timeLeft = r.secondsPerRound;

        io.to(currentRoom).emit("game:beginClient", pack(r));
        startTick(r);
    }

    function pack(r) {
        return {
            code: currentRoom,
            players: r.players,
            me: { id: me.id, name: me.name, score: me.score },
            drawerId: r.drawerId,
            word: r.drawerId === me.id ? r.word : null,
            maskedWord: r.maskedWord,
            round: r.round,
            totalRounds: r.totalRounds,
            timeLeft: r.timeLeft
        };
    }

    function startTick(r) {
        clearInterval(r._intv);
        r._intv = setInterval(() => {
            r.timeLeft -= 1;
            io.to(currentRoom).emit("timer:tick", r.timeLeft);
            if (r.timeLeft <= 0) {
                clearInterval(r._intv);
                io.to(currentRoom).emit("chat:new", `⏱️ Time up! Word was: ${r.word}`);
                r.turnIndex += 1;
                updateRound(r);
                nextTurn(r);
            }
        }, 1000);
    }
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server listening on Port ${PORT}`));
