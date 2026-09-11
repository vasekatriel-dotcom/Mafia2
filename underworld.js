#!/usr/bin/env node
// underworld.js
// One file, zero npm dependencies (pure Node built-ins). Run it, share the
// WiFi link it prints, play. Real multiplayer -- the server holds all
// secret state (roles, votes) in memory and only ever sends each phone
// the slice of information they're allowed to see.
//
// Run:  node underworld.js
// Then open the printed link on your computer (you'll become the
// Narrator), and share the "for guests" link with everyone on the same
// WiFi.

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const G = require('./logic.js');
const NAME_POOL = require('./names.js');

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------
// In-memory game state -- resets if the process restarts. That's an
// accepted tradeoff for a zero-dependency, zero-setup local party server.
// ---------------------------------------------------------------

function freshGame() {
  return {
    narratorToken: null,
    phase: 'lobby', // lobby | night-mafia | night-doctor | night-detective | night-resolve | day-discuss | day-vote | day-revote | ended
    round: 0,
    winner: null,
    detectiveActivated: false,
    detectiveUid: null,
    doctorExtraSaveActive: false,
    dayVoteCandidates: null, // null = all living players eligible
    log: [], // { ts, text } -- public reveal log
    players: {}, // uid -> { token, realName, codeName, role, alive, eliminatedRound, connected, puzzle:{quiz,solved,daggerAvailable} }
    usedCodeNames: [],
    votes: { mafiaKill: {}, doctorSave: {}, detectiveCheck: {}, dayVote: {} },
    mafiaChat: [],
    nightEffects: { doubleVoteUid: null }
  };
}

let game = freshGame();

function newUid() { return crypto.randomBytes(9).toString('base64url'); }
function newToken() { return crypto.randomBytes(18).toString('base64url'); }

function pushLog(text) { game.log.push({ ts: Date.now(), text }); }

function livingPlayers() { return Object.values(game.players).filter(p => p.alive); }
function playerByToken(token) { return Object.values(game.players).find(p => p.token === token); }
function codeNameOf(uid) { return game.players[uid] ? game.players[uid].codeName : '(unknown)'; }

// ---------------------------------------------------------------
// Actions -- each returns data or throws Error(message)
// ---------------------------------------------------------------

function actionJoin(realName) {
  const clean = String(realName || '').trim().slice(0, 40);
  if (!clean) throw new Error('Please enter your real name.');
  if (game.phase !== 'lobby') throw new Error('The game has already started -- ask the Narrator for a new game.');
  const codeName = G.pickAvailableName(NAME_POOL, game.usedCodeNames);
  if (!codeName) throw new Error('The house is full tonight -- no code names left.');
  game.usedCodeNames.push(codeName);
  const uid = newUid();
  const token = newToken();
  game.players[uid] = {
    uid, token, realName: clean, codeName, role: null, alive: true, connected: true,
    eliminatedRound: null, puzzle: { quiz: null, solved: false, daggerAvailable: false }
  };
  pushLog(`${codeName} arrived.`);
  return { token, codeName };
}

function actionClaimNarrator() {
  if (game.narratorToken) throw new Error('This game already has a Narrator.');
  game.narratorToken = newToken();
  return { token: game.narratorToken };
}

function actionStartGame() {
  const uids = Object.keys(game.players);
  if (uids.length < 5) throw new Error('Need at least 5 guests to start.');
  const roles = G.assignRoles(uids);
  for (const uid of uids) game.players[uid].role = roles[uid];
  game.phase = 'night-mafia';
  game.round = 1;
  pushLog('The city falls silent. Night one begins.');
}

function livingMafiaUids() { return Object.values(game.players).filter(p => p.alive && p.role === G.ROLES.MAFIA).map(p => p.uid); }
function livingDoctor() { return Object.values(game.players).find(p => p.alive && p.role === G.ROLES.DOCTOR); }
function livingDetective() { return Object.values(game.players).find(p => p.alive && p.role === G.ROLES.DETECTIVE); }

function flatPlayersForLogic() {
  const out = {};
  for (const [uid, p] of Object.entries(game.players)) out[uid] = { alive: p.alive, role: p.role };
  return out;
}

function afterElimination() {
  const winner = G.checkWinCondition(flatPlayersForLogic());
  if (winner) {
    game.winner = winner;
    game.phase = 'ended';
    return true;
  }
  const detUid = G.maybeActivateDetective(flatPlayersForLogic(), game.detectiveActivated);
  if (detUid) {
    game.players[detUid].role = G.ROLES.DETECTIVE;
    game.detectiveActivated = true;
    game.detectiveUid = detUid;
    pushLog('Someone in town has started asking very pointed questions.');
  }
  return false;
}

function actionNarratorContinue() {
  const phase = game.phase;
  if (phase === 'night-mafia') {
    game.phase = 'night-doctor';
  } else if (phase === 'night-doctor') {
    const det = livingDetective();
    game.phase = (game.detectiveActivated && det) ? 'night-detective' : 'night-resolve';
  } else if (phase === 'night-detective') {
    game.phase = 'night-resolve';
  } else if (phase === 'night-resolve') {
    resolveNight();
  } else {
    throw new Error('Nothing to continue from phase ' + phase);
  }
}

function resolveNight() {
  const killVotes = Object.entries(game.votes.mafiaKill).map(([uid, v]) => ({ uid, target: v.target, ts: v.ts }));
  const killTarget = G.resolveMafiaKill(killVotes);
  const savedTargets = Object.values(game.votes.doctorSave).flatMap(v => v.targets || []);

  if (killTarget && !savedTargets.includes(killTarget) && game.players[killTarget] && game.players[killTarget].alive) {
    game.players[killTarget].alive = false;
    game.players[killTarget].eliminatedRound = game.round;
    pushLog(G.nightKillMessage(codeNameOf(killTarget)));
  } else {
    pushLog(G.noOneKilledMessage());
  }
  game.doctorExtraSaveActive = false;
  game.votes.mafiaKill = {};
  game.votes.doctorSave = {};
  game.votes.detectiveCheck = {};

  if (afterElimination()) return;
  game.phase = 'day-discuss';
}

function actionCallVote() {
  if (game.phase !== 'day-discuss') throw new Error('Can only call the vote during discussion.');
  game.votes.dayVote = {};
  game.dayVoteCandidates = null;
  game.phase = 'day-vote';
}

function actionResolveDayVote() {
  if (game.phase !== 'day-vote' && game.phase !== 'day-revote') throw new Error('Not currently voting.');
  const doubleUid = game.nightEffects.doubleVoteUid;
  let votes = Object.entries(game.votes.dayVote).map(([uid, target]) => ({ uid, target }));
  if (doubleUid && game.votes.dayVote[doubleUid]) {
    votes.push({ uid: doubleUid + '-dagger', target: game.votes.dayVote[doubleUid] });
  }
  const tally = G.tallyDayVotes(votes);

  if (tally.tie) {
    game.dayVoteCandidates = tally.candidates;
    game.votes.dayVote = {};
    game.phase = 'day-revote';
    pushLog('The vote is tied -- a re-vote is called among the tied names.');
    return;
  }

  const lynchedUid = tally.winner;
  const wasMafia = game.players[lynchedUid].role === G.ROLES.MAFIA;
  game.players[lynchedUid].alive = false;
  game.players[lynchedUid].eliminatedRound = game.round;
  pushLog(G.dayLynchMessage(codeNameOf(lynchedUid), wasMafia));
  game.nightEffects.doubleVoteUid = null;
  game.votes.dayVote = {};
  game.dayVoteCandidates = null;

  if (afterElimination()) return;
  game.round += 1;
  game.phase = 'night-mafia';
}

function actionNewGame(keepNarratorToken) {
  const nt = keepNarratorToken;
  game = freshGame();
  game.narratorToken = nt;
}

// ---------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------
// State payloads (what each viewer is allowed to see)
// ---------------------------------------------------------------

function publicPlayerList() {
  return Object.values(game.players).map(p => ({ uid: p.uid, codeName: p.codeName, alive: p.alive, connected: p.connected }));
}

function narratorStatePayload() {
  return {
    ok: true, viewer: 'narrator',
    phase: game.phase, round: game.round, winner: game.winner,
    doctorExtraSaveActive: game.doctorExtraSaveActive,
    detectiveActivated: game.detectiveActivated,
    dayVoteCandidates: game.dayVoteCandidates,
    players: publicPlayerList(),
    log: game.log,
    status: buildNarratorStatus()
  };
}

function buildNarratorStatus() {
  const phase = game.phase;
  if (phase === 'night-mafia') {
    const living = livingMafiaUids();
    return { kind: 'mafia', entries: living.map(uid => ({ label: codeNameOf(uid), done: !!game.votes.mafiaKill[uid] })), ready: living.length > 0 && living.every(uid => game.votes.mafiaKill[uid]) };
  }
  if (phase === 'night-doctor') {
    const doc = livingDoctor();
    if (!doc) return { kind: 'doctor', entries: [{ label: 'The Doctor is no longer with us.', done: true }], ready: true };
    return { kind: 'doctor', entries: [{ label: 'Doctor', done: !!game.votes.doctorSave[doc.uid] }], ready: !!game.votes.doctorSave[doc.uid] };
  }
  if (phase === 'night-detective') {
    const det = livingDetective();
    const done = det && !!game.votes.detectiveCheck[det.uid];
    return { kind: 'detective', entries: [{ label: 'Detective', done: !!done }], ready: true };
  }
  if (phase === 'night-resolve') {
    return { kind: 'resolve', entries: [{ label: 'Ready to reveal the night.', done: true }], ready: true };
  }
  if (phase === 'day-discuss') {
    return { kind: 'discuss', entries: [], ready: true };
  }
  if (phase === 'day-vote' || phase === 'day-revote') {
    const living = livingPlayers();
    return { kind: 'vote', entries: living.map(p => ({ label: p.codeName, done: !!game.votes.dayVote[p.uid] })), ready: living.every(p => game.votes.dayVote[p.uid]) };
  }
  return { kind: phase, entries: [], ready: false };
}

function guestStatePayload(p) {
  const base = {
    ok: true, viewer: 'guest',
    phase: game.phase, round: game.round, winner: game.winner,
    codeName: p.codeName, role: p.role, alive: p.alive,
    doctorExtraSaveActive: game.doctorExtraSaveActive,
    dayVoteCandidates: game.dayVoteCandidates,
    players: publicPlayerList(),
    log: game.log,
    puzzle: { solved: p.puzzle.solved, hasQuiz: !!p.puzzle.quiz, daggerAvailable: p.puzzle.daggerAvailable }
  };
  if (!p.alive) return base;

  if (game.phase === 'night-mafia' && p.role === G.ROLES.MAFIA) {
    base.mafiaChat = game.mafiaChat;
    base.myVote = game.votes.mafiaKill[p.uid] ? game.votes.mafiaKill[p.uid].target : null;
    base.mafiaCodeNames = livingMafiaUids().map(codeNameOf);
  }
  if (game.phase === 'night-doctor' && p.role === G.ROLES.DOCTOR) {
    base.mySave = (game.votes.doctorSave[p.uid] || {}).targets || [];
  }
  if (game.phase === 'night-detective' && p.role === G.ROLES.DETECTIVE) {
    const mine = game.votes.detectiveCheck[p.uid];
    base.myCheck = mine ? { target: mine.target, result: mine.result } : null;
  }
  if ((game.phase === 'day-vote' || game.phase === 'day-revote')) {
    base.myDayVote = game.votes.dayVote[p.uid] || null;
  }
  return base;
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/') {
      const html = renderPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const token = url.searchParams.get('token') || '';
      if (game.narratorToken && token === game.narratorToken) return sendJson(res, 200, narratorStatePayload());
      const p = playerByToken(token);
      if (p) { p.connected = true; return sendJson(res, 200, guestStatePayload(p)); }
      return sendJson(res, 200, { ok: false, error: 'not_found' });
    }

    if (req.method === 'POST' && pathname === '/api/join') {
      const body = await readBody(req);
      try {
        const result = actionJoin(body.realName);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
    }

    if (req.method === 'POST' && pathname === '/api/narrator/claim') {
      try {
        const result = actionClaimNarrator();
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readBody(req);
      try {
        const result = handleAction(body);
        return sendJson(res, 200, { ok: true, ...(result || {}) });
      } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'Server error: ' + err.message });
  }
});

function requireNarrator(token) {
  if (!game.narratorToken || token !== game.narratorToken) throw new Error('Narrator only.');
}
function requirePlayer(token) {
  const p = playerByToken(token);
  if (!p) throw new Error('Unknown player.');
  return p;
}

function handleAction(body) {
  const { type, token } = body;
  switch (type) {
    case 'narrator:start': requireNarrator(token); actionStartGame(); return {};
    case 'narrator:continue': requireNarrator(token); actionNarratorContinue(); return {};
    case 'narrator:callVote': requireNarrator(token); actionCallVote(); return {};
    case 'narrator:resolveVote': requireNarrator(token); actionResolveDayVote(); return {};
    case 'narrator:newGame': requireNarrator(token); actionNewGame(token); return {};

    case 'mafia:vote': {
      const p = requirePlayer(token);
      if (p.role !== G.ROLES.MAFIA || !p.alive) throw new Error('Only living Mafia may target.');
      if (game.phase !== 'night-mafia') throw new Error('Not the Mafia phase.');
      game.votes.mafiaKill[p.uid] = { target: body.target, ts: Date.now() };
      return {};
    }
    case 'mafia:chat': {
      const p = requirePlayer(token);
      if (p.role !== G.ROLES.MAFIA || !p.alive) throw new Error('Only living Mafia may chat here.');
      const text = String(body.text || '').slice(0, 500).trim();
      if (!text) throw new Error('Empty message.');
      game.mafiaChat.push({ from: p.codeName, text, ts: Date.now() });
      return {};
    }
    case 'doctor:save': {
      const p = requirePlayer(token);
      if (p.role !== G.ROLES.DOCTOR || !p.alive) throw new Error('Only the living Doctor may save.');
      if (game.phase !== 'night-doctor') throw new Error('Not the Doctor phase.');
      const max = game.doctorExtraSaveActive ? 2 : 1;
      const targets = Array.isArray(body.targets) ? body.targets.slice(0, max) : [];
      game.votes.doctorSave[p.uid] = { targets, ts: Date.now() };
      return {};
    }
    case 'detective:investigate': {
      const p = requirePlayer(token);
      if (p.role !== G.ROLES.DETECTIVE || !p.alive) throw new Error('Only the living Detective may investigate.');
      if (game.phase !== 'night-detective') throw new Error('Not the Detective phase.');
      const target = game.players[body.target];
      if (!target) throw new Error('Unknown target.');
      const result = target.role === G.ROLES.MAFIA;
      game.votes.detectiveCheck[p.uid] = { target: body.target, result, ts: Date.now() };
      return { result };
    }
    case 'day:vote': {
      const p = requirePlayer(token);
      if (!p.alive) throw new Error('Only living players vote.');
      if (game.phase !== 'day-vote' && game.phase !== 'day-revote') throw new Error('Not voting right now.');
      if (game.dayVoteCandidates && !game.dayVoteCandidates.includes(body.target)) throw new Error('That name is not on the re-vote ballot.');
      game.votes.dayVote[p.uid] = body.target;
      return {};
    }
    case 'puzzle:request': {
      const p = requirePlayer(token);
      if (p.alive) throw new Error('Only eliminated players get the puzzle.');
      p.puzzle.quiz = G.generateMathQuestions(10);
      return { questions: p.puzzle.quiz.map(({ id, a, b, op }) => ({ id, a, b, op })) };
    }
    case 'puzzle:submit': {
      const p = requirePlayer(token);
      if (!p.puzzle.quiz) throw new Error('No active puzzle -- request one first.');
      const result = G.gradeMathQuiz(p.puzzle.quiz, body.answers || []);
      p.puzzle.quiz = null;
      if (result.allCorrect) {
        p.puzzle.solved = true;
        const wasMafia = p.role === G.ROLES.MAFIA;
        if (wasMafia) {
          p.puzzle.daggerAvailable = true;
          pushLog('Someone in the shadows has forged a dagger.');
        } else {
          game.doctorExtraSaveActive = true;
          pushLog('Word is the Doctor has an extra dose tonight.');
        }
      }
      return { result };
    }
    case 'dagger:bestow': {
      const p = requirePlayer(token);
      if (!(p.role === G.ROLES.MAFIA && !p.alive && p.puzzle.daggerAvailable)) throw new Error('You have no dagger to give.');
      const target = game.players[body.target];
      if (!target || !target.alive) throw new Error('The dagger must go to a living player.');
      game.nightEffects.doubleVoteUid = body.target;
      p.puzzle.daggerAvailable = false;
      return {};
    }
    default:
      throw new Error('Unknown action: ' + type);
  }
}

// ---------------------------------------------------------------
// Embedded frontend
// ---------------------------------------------------------------

function renderPage() {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1" />\n' +
    '<title>The Underworld</title>\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;900&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Jost:wght@400;500;600&display=swap" rel="stylesheet" />\n' +
    '<style>' + CSS + '</style>\n</head>\n<body>\n' +
    '<div class="cheetah-rule" aria-hidden="true"></div>\n' +
    '<header id="topbar"><h1>THE UNDERWORLD</h1></header>\n' +
    '<main id="app">\n' + VIEWS_HTML + '\n</main>\n' +
    '<nav id="tabbar" class="hidden">\n' +
    '  <button data-tab="view-guest-role" class="tabbtn">Identity</button>\n' +
    '  <button data-tab="view-log" class="tabbtn">Log</button>\n' +
    '</nav>\n' +
    '<script>' + CLIENT_JS + '</script>\n</body>\n</html>';
}

const CSS = [
  ':root{--bg-0:#0c0c0d;--bg-1:#151416;--panel:rgba(24,22,24,.85);--gold:#c9a24b;--gold-bright:#e8c97a;--red:#8a1f2b;--red-bright:#b32d3a;--text:#f0ece4;--muted:#9a9490;--border:rgba(201,162,75,.25);--border-strong:rgba(201,162,75,.55);--deco:\'Cinzel\',Georgia,serif;--script:\'Cormorant Garamond\',Georgia,serif;--sans:\'Jost\',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
  '*{box-sizing:border-box}html,body{margin:0;min-height:100vh}',
  'body{background:radial-gradient(ellipse 800px 500px at 20% 0%,rgba(138,31,43,.18),transparent 60%),linear-gradient(160deg,var(--bg-0),var(--bg-1) 60%,#0c0c0d);color:var(--text);font-family:var(--sans);min-height:100vh;padding-bottom:76px}',
  '.cheetah-rule{height:7px;width:100%;background-color:var(--red);background-image:radial-gradient(circle at 10% 40%,#1a1a1a 0 2px,transparent 2.5px),radial-gradient(circle at 30% 70%,#1a1a1a 0 2.2px,transparent 2.7px),radial-gradient(circle at 50% 30%,#1a1a1a 0 1.8px,transparent 2.2px),radial-gradient(circle at 70% 65%,#1a1a1a 0 2.4px,transparent 2.9px),radial-gradient(circle at 88% 35%,#1a1a1a 0 2px,transparent 2.5px);background-size:60px 7px;background-repeat:repeat-x;opacity:.9}',
  '#topbar{padding:20px 18px 14px;text-align:center;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(12,12,13,.9),rgba(12,12,13,.6))}',
  '#topbar h1{font-family:var(--deco);font-weight:900;letter-spacing:.22em;font-size:1.3rem;margin:0;color:var(--gold-bright);text-shadow:0 0 22px rgba(201,162,75,.3)}',
  'main#app{max-width:620px;margin:0 auto;padding:22px 16px}',
  '.view.hidden{display:none}',
  'h2,h3{font-family:var(--deco);color:var(--gold-bright);letter-spacing:.03em;margin-top:0}',
  'h2{font-size:1.3rem}h3{font-size:1rem;text-transform:uppercase;letter-spacing:.12em;color:var(--gold)}',
  '.eyebrow{font-family:var(--script);font-style:italic;color:var(--muted);font-size:1.05rem;margin:0 0 2px}',
  '.hero-title{font-family:var(--deco);font-weight:700;font-size:1.7rem;margin:0 0 10px;color:var(--gold-bright)}',
  '.fieldlabel{display:block;font-size:.78rem;color:var(--muted);margin:14px 0 6px;letter-spacing:.06em;text-transform:uppercase}',
  '.card{background:var(--panel);border:1px solid var(--border);border-top:3px solid var(--red);border-radius:4px;padding:20px;margin-bottom:16px;box-shadow:0 12px 30px -16px rgba(0,0,0,.7)}',
  '.card.center{text-align:center}',
  '.rolepill{display:inline-block;background:rgba(138,31,43,.28);border:1px solid var(--border-strong);padding:6px 16px;border-radius:3px;font-family:var(--deco);letter-spacing:.05em}',
  '.hint{color:var(--muted);font-size:.88rem;line-height:1.55}',
  '.flavor{color:var(--gold-bright);font-family:var(--script);font-size:1.1rem}',
  '.error{color:#e08a8a;font-size:.85rem}',
  '.divider{display:flex;align-items:center;gap:10px;margin:18px 0 10px;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}',
  '.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}',
  'button{font:inherit;padding:12px 18px;border-radius:3px;border:1px solid var(--border);background:rgba(201,162,75,.08);color:var(--text);cursor:pointer;font-weight:500;letter-spacing:.02em}',
  'button:hover{border-color:var(--border-strong)}',
  'button.primary{background:linear-gradient(135deg,var(--red),var(--red-bright));border-color:var(--border-strong);color:var(--gold-bright);font-weight:600;width:100%}',
  'button.ghost{background:transparent;border:1px solid var(--border-strong);width:100%}',
  'button:disabled{opacity:.4;cursor:not-allowed}',
  'input{font:inherit;padding:12px 14px;border-radius:3px;border:1px solid var(--border);background:rgba(0,0,0,.4);color:var(--text);width:100%}',
  'input:focus{outline:none;border-color:var(--border-strong)}',
  '.row{display:flex;gap:8px;margin-bottom:4px}',
  '.playerlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
  '.playerlist li{display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,.35);border:1px solid transparent;padding:11px 14px;border-radius:3px}',
  '.playerlist li button{padding:7px 14px;font-size:.82rem;width:auto}',
  '.playerlist li .waiting{color:var(--muted);font-size:.8rem}',
  '.playerlist li .done{color:#8fd19e;font-size:.8rem}',
  '.chatlog{height:160px;overflow-y:auto;background:rgba(0,0,0,.45);border:1px solid var(--border);border-radius:3px;padding:10px;font-size:.85rem;margin-bottom:8px}',
  '.chatlog .msg{margin-bottom:5px;line-height:1.4}',
  '.chatlog .msg .from{color:var(--gold);font-weight:600}',
  '.chatinput{display:flex;gap:8px}.chatinput input{flex:1}.chatinput button{width:auto}',
  '#puzzleForm{display:flex;flex-direction:column;gap:8px;margin:10px 0}',
  '#puzzleForm .q{display:flex;align-items:center;gap:10px}',
  '#puzzleForm .q span{font-family:var(--script);font-size:1.2rem;min-width:90px}',
  '#puzzleForm input{width:84px;flex:none}',
  '#tabbar{position:fixed;bottom:0;left:0;right:0;display:flex;background:rgba(12,12,13,.94);border-top:1px solid var(--border);z-index:20}',
  '#tabbar.hidden{display:none}',
  '.tabbtn{flex:1;border:none;border-radius:0;background:transparent;padding:13px;color:var(--muted)}',
  '.tabbtn.active{color:var(--gold-bright);font-weight:700;border-top:2px solid var(--red-bright)}'
].join('\n');

const VIEWS_HTML = [
  '<section id="view-landing" class="view">',
  '  <div class="card">',
  '    <p class="eyebrow">A speakeasy after dark</p>',
  '    <h2 class="hero-title">Welcome, stranger.</h2>',
  '    <p class="hint">Are you running tonight\'s game, or joining it?</p>',
  '    <div class="row"><button id="btnBeNarrator" class="ghost">I\'m the Narrator</button></div>',
  '    <div class="divider"><span>or join as a guest</span></div>',
  '    <label class="fieldlabel" for="realNameInput">Your real name</label>',
  '    <input id="realNameInput" placeholder="e.g. Sana Patel" maxlength="40" autocomplete="name" />',
  '    <button id="btnJoinGuest" class="primary">Enter the speakeasy</button>',
  '    <p id="landingError" class="error hidden"></p>',
  '  </div>',
  '</section>',

  '<section id="view-guest-lobby" class="view hidden">',
  '  <div class="card">',
  '    <p class="eyebrow">You are known here as</p>',
  '    <h2 id="guestCodeName" class="hero-title"></h2>',
  '    <p class="hint">Sit tight -- the Narrator will start the game once everyone has arrived.</p>',
  '  </div>',
  '</section>',

  '<section id="view-guest-role" class="view hidden">',
  '  <div class="card">',
  '    <p class="eyebrow">Your identity tonight</p>',
  '    <h2 id="roleCodeName" class="hero-title"></h2>',
  '    <p class="rolepill"><strong id="roleName"></strong></p>',
  '    <p id="roleFlavor" class="flavor"></p>',
  '  </div>',
  '</section>',

  '<section id="view-guest-sleep" class="view hidden">',
  '  <div class="card center">',
  '    <p class="eyebrow">The city sleeps</p>',
  '    <h2 class="hero-title">Eyes closed.</h2>',
  '    <p class="hint">The Narrator is speaking. Wait for daylight.</p>',
  '  </div>',
  '</section>',

  '<section id="view-guest-mafia" class="view hidden">',
  '  <div class="card"><h2>Choose your mark</h2><ul id="mafiaTargetList" class="playerlist"></ul></div>',
  '  <div class="card">',
  '    <h3>The Family line</h3>',
  '    <div id="mafiaChatLog" class="chatlog"></div>',
  '    <div class="chatinput">',
  '      <input id="mafiaChatInput" placeholder="Speak quietly..." maxlength="500" />',
  '      <button id="btnMafiaSend">Send</button>',
  '    </div>',
  '  </div>',
  '</section>',

  '<section id="view-guest-doctor" class="view hidden">',
  '  <div class="card"><h2>Choose who to protect <span id="doctorExtraHint"></span></h2><ul id="doctorTargetList" class="playerlist"></ul></div>',
  '</section>',

  '<section id="view-guest-detective" class="view hidden">',
  '  <div class="card"><h2>Investigate one soul</h2><ul id="detectiveTargetList" class="playerlist"></ul><p id="detectiveResult" class="flavor"></p></div>',
  '</section>',

  '<section id="view-guest-discuss" class="view hidden">',
  '  <div class="card center">',
  '    <p class="eyebrow">Daylight</p>',
  '    <h2 class="hero-title">The floor is open.</h2>',
  '    <p class="hint">Talk it out. The Narrator will call the vote when ready.</p>',
  '  </div>',
  '</section>',

  '<section id="view-guest-vote" class="view hidden">',
  '  <div class="card"><h2 id="voteHeading">Cast your vote</h2><ul id="voteList" class="playerlist"></ul></div>',
  '</section>',

  '<section id="view-guest-eliminated" class="view hidden">',
  '  <div class="card"><h2>You\'ve been eliminated</h2><p class="hint">The night goes on without you -- but you\'ve got one more play.</p></div>',
  '  <div id="daggerPanel" class="card hidden">',
  '    <h3>Dagger in hand</h3>',
  '    <p class="hint">Hand it to a living player -- their vote counts double next day-vote.</p>',
  '    <ul id="daggerTargetList" class="playerlist"></ul>',
  '  </div>',
  '  <div id="puzzlePanel" class="card">',
  '    <h3>One more shot</h3>',
  '    <p id="puzzleIntro" class="hint">Solve all 10 to earn a reward. No clock -- take your time.</p>',
  '    <form id="puzzleForm"></form>',
  '    <button id="btnSubmitPuzzle" class="primary hidden">Submit</button>',
  '    <p id="puzzleResult" class="flavor"></p>',
  '  </div>',
  '</section>',

  '<section id="view-log" class="view hidden">',
  '  <div class="card"><h3>What\'s happened so far</h3><div id="revealLog" class="chatlog"></div></div>',
  '</section>',

  '<section id="view-gameover" class="view hidden">',
  '  <div class="card center"><h2 id="gameOverTitle" class="hero-title"></h2><p id="gameOverBody" class="hint"></p></div>',
  '</section>',

  '<section id="view-narrator" class="view hidden">',
  '  <div class="card">',
  '    <h2>Narrator dashboard</h2>',
  '    <p id="narratorPhaseLabel" class="rolepill"></p>',
  '    <p class="hint" id="narratorLink"></p>',
  '    <div id="narratorLobbyBox" class="hidden">',
  '      <ul id="narratorLobbyList" class="playerlist"></ul>',
  '      <button id="btnStartGame" class="primary">Start Game</button>',
  '      <p class="hint">Needs at least 5 guests joined.</p>',
  '    </div>',
  '  </div>',
  '  <div id="narratorStatusBox" class="card hidden">',
  '    <h3>Status</h3>',
  '    <ul id="narratorStatusList" class="playerlist"></ul>',
  '    <button id="btnNarratorContinue" class="primary hidden">Continue</button>',
  '    <button id="btnCallVote" class="primary hidden">Call the Vote</button>',
  '  </div>',
  '  <div class="card"><h3>Reveal log</h3><div id="narratorLog" class="chatlog"></div></div>',
  '  <div id="narratorEndBox" class="card hidden">',
  '    <h2 id="narratorGameOverTitle" class="hero-title"></h2>',
  '    <button id="btnNewGame" class="primary">Start a New Game</button>',
  '  </div>',
  '</section>'
].join('\n');

const CLIENT_JS = `
let myToken = localStorage.getItem('uw_token') || null;
let myKind = localStorage.getItem('uw_kind') || null;
let state = null;
let currentQuiz = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function showView(id){ $$('.view').forEach(v=>v.classList.add('hidden')); const el=$('#'+id); if(el) el.classList.remove('hidden'); }
function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function api(path, body){
  const res = await fetch(path, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) } : {});
  return res.json();
}

document.getElementById('btnBeNarrator').addEventListener('click', async () => {
  const r = await api('/api/narrator/claim', {});
  if(!r.ok){ showError(r.error); return; }
  myToken = r.token; myKind = 'narrator';
  localStorage.setItem('uw_token', myToken); localStorage.setItem('uw_kind', 'narrator');
  poll();
});

document.getElementById('btnJoinGuest').addEventListener('click', async () => {
  const realName = $('#realNameInput').value.trim();
  if(!realName){ $('#realNameInput').focus(); return; }
  const r = await api('/api/join', { realName });
  if(!r.ok){ showError(r.error); return; }
  myToken = r.token; myKind = 'guest';
  localStorage.setItem('uw_token', myToken); localStorage.setItem('uw_kind', 'guest');
  poll();
});

function showError(msg){ const el=$('#landingError'); el.textContent = msg; el.classList.remove('hidden'); }

async function poll(){
  if(!myToken){ showView('view-landing'); return; }
  const r = await fetch('/api/state?token=' + encodeURIComponent(myToken)).then(x=>x.json());
  if(!r.ok){ myToken=null; localStorage.removeItem('uw_token'); showView('view-landing'); return; }
  state = r;
  render();
}
setInterval(poll, 1500);
poll();

function render(){
  if(!state) return;
  if(state.viewer === 'narrator'){ $('#tabbar').classList.add('hidden'); renderNarrator(); showView('view-narrator'); return; }
  renderGuest();
}

function renderGuest(){
  $('#tabbar').classList.remove('hidden');
  $$('.tabbtn').forEach(b => { b.onclick = () => { $$('.tabbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); showView(b.dataset.tab); }; });

  if(state.winner){
    $('#tabbar').classList.add('hidden');
    $('#gameOverTitle').textContent = state.winner === 'town' ? 'The Town Wins.' : 'The Mafia Wins.';
    $('#gameOverBody').textContent = state.role ? ('You were the ' + state.role + '.') : '';
    showView('view-gameover'); return;
  }
  if(state.phase === 'lobby'){ $('#guestCodeName').textContent = state.codeName; showView('view-guest-lobby'); return; }
  if(!state.alive){ renderEliminated(); if(!document.querySelector('.tabbtn.active[data-tab="view-log"]')) showView('view-guest-eliminated'); renderLog(); return; }

  renderRoleCard();
  renderLog();

  let phaseView;
  const role = state.role, phase = state.phase;
  if(phase === 'night-mafia'){ if(role==='Mafia'){ renderMafia(); phaseView='view-guest-mafia'; } else phaseView='view-guest-sleep'; }
  else if(phase === 'night-doctor'){ if(role==='Doctor'){ renderDoctor(); phaseView='view-guest-doctor'; } else phaseView='view-guest-sleep'; }
  else if(phase === 'night-detective'){ if(role==='Detective'){ renderDetective(); phaseView='view-guest-detective'; } else phaseView='view-guest-sleep'; }
  else if(phase === 'night-resolve'){ phaseView='view-guest-sleep'; }
  else if(phase === 'day-discuss'){ phaseView='view-guest-discuss'; }
  else if(phase === 'day-vote' || phase === 'day-revote'){ renderVote(); phaseView='view-guest-vote'; }
  else phaseView='view-guest-lobby';

  const activeTab = document.querySelector('.tabbtn.active[data-tab="view-guest-role"], .tabbtn.active[data-tab="view-log"]');
  showView(activeTab ? activeTab.dataset.tab : phaseView);
}

function renderRoleCard(){
  $('#roleCodeName').textContent = state.codeName;
  $('#roleName').textContent = state.role || '(awaiting assignment)';
  const flavor = { Mafia:'Know your family. Choose your marks wisely.', Doctor:'One life in your hands, every night.', Villager:'Trust carefully. The city is not what it seems.', Detective:'You have learned to see what others cannot.' };
  $('#roleFlavor').textContent = state.role ? (flavor[state.role]||'') : '';
}

function livingOthers(){ return (state.players||[]).filter(p=>p.alive); }

function renderMafia(){
  const list = $('#mafiaTargetList'); list.innerHTML='';
  livingOthers().filter(p => !(state.mafiaCodeNames||[]).includes(p.codeName)).forEach(p=>{
    const li=document.createElement('li');
    li.innerHTML = '<span>'+esc(p.codeName)+(state.myVote===p.uid?' \u2014 marked':'')+'</span>';
    const btn=document.createElement('button'); btn.textContent='Mark';
    btn.addEventListener('click', async ()=>{ await api('/api/action',{type:'mafia:vote',token:myToken,target:p.uid}); poll(); });
    li.appendChild(btn); list.appendChild(li);
  });
  renderMafiaChat();
}
document.getElementById('btnMafiaSend').addEventListener('click', sendMafiaChat);
document.getElementById('mafiaChatInput').addEventListener('keydown', e=>{ if(e.key==='Enter') sendMafiaChat(); });
async function sendMafiaChat(){
  const input=$('#mafiaChatInput'); if(!input.value.trim()) return;
  await api('/api/action',{type:'mafia:chat',token:myToken,text:input.value});
  input.value=''; poll();
}
function renderMafiaChat(){
  const log=$('#mafiaChatLog'); if(!log) return; log.innerHTML='';
  (state.mafiaChat||[]).forEach(m=>{
    const d=document.createElement('div'); d.className='msg';
    d.innerHTML='<span class="from">'+esc(m.from)+':</span> '+esc(m.text);
    log.appendChild(d);
  });
  log.scrollTop = log.scrollHeight;
}

function renderDoctor(){
  $('#doctorExtraHint').textContent = state.doctorExtraSaveActive ? '(extra dose tonight -- pick up to two)' : '';
  const list=$('#doctorTargetList'); list.innerHTML='';
  let picked = state.mySave ? state.mySave.slice() : [];
  livingOthers().forEach(p=>{
    const li=document.createElement('li'); li.innerHTML='<span>'+esc(p.codeName)+'</span>';
    const btn=document.createElement('button'); btn.textContent = picked.includes(p.uid) ? '\u2713 Protected' : 'Protect';
    btn.addEventListener('click', async ()=>{
      const max = state.doctorExtraSaveActive ? 2 : 1;
      picked = picked.includes(p.uid) ? picked.filter(x=>x!==p.uid) : [...picked, p.uid].slice(-max);
      await api('/api/action',{type:'doctor:save',token:myToken,targets:picked});
      poll();
    });
    li.appendChild(btn); list.appendChild(li);
  });
}

function renderDetective(){
  const list=$('#detectiveTargetList'); list.innerHTML='';
  livingOthers().forEach(p=>{
    const li=document.createElement('li'); li.innerHTML='<span>'+esc(p.codeName)+'</span>';
    const btn=document.createElement('button'); btn.textContent='Investigate';
    btn.addEventListener('click', async ()=>{
      const r = await api('/api/action',{type:'detective:investigate',token:myToken,target:p.uid});
      if(r.ok){ $('#detectiveResult').textContent = p.codeName + (r.result ? ' IS Mafia.' : ' is NOT Mafia.'); }
      poll();
    });
    li.appendChild(btn); list.appendChild(li);
  });
  if(state.myCheck){
    const p = (state.players||[]).find(x=>x.uid===state.myCheck.target);
    $('#detectiveResult').textContent = (p?p.codeName:'') + (state.myCheck.result ? ' IS Mafia.' : ' is NOT Mafia.');
  }
}

function renderVote(){
  $('#voteHeading').textContent = state.phase === 'day-revote' ? 'Tied -- vote again' : 'Cast your vote';
  const list=$('#voteList'); list.innerHTML='';
  const candidates = state.dayVoteCandidates ? livingOthers().filter(p=>state.dayVoteCandidates.includes(p.uid)) : livingOthers();
  candidates.forEach(p=>{
    const li=document.createElement('li'); li.innerHTML='<span>'+esc(p.codeName)+'</span>';
    const btn=document.createElement('button');
    const already = state.myDayVote === p.uid;
    btn.textContent = already ? '\u2713 Voted' : 'Vote';
    btn.disabled = !!state.myDayVote;
    btn.addEventListener('click', async ()=>{ await api('/api/action',{type:'day:vote',token:myToken,target:p.uid}); poll(); });
    li.appendChild(btn); list.appendChild(li);
  });
}

function renderEliminated(){
  const hasDagger = state.puzzle && state.puzzle.daggerAvailable;
  $('#daggerPanel').classList.toggle('hidden', !hasDagger);
  if(hasDagger){
    const list=$('#daggerTargetList'); list.innerHTML='';
    livingOthers().forEach(p=>{
      const li=document.createElement('li'); li.innerHTML='<span>'+esc(p.codeName)+'</span>';
      const btn=document.createElement('button'); btn.textContent='Hand the dagger';
      btn.addEventListener('click', async ()=>{
        if(!confirm('Give the dagger to '+p.codeName+'? Their vote counts double next day-vote.')) return;
        await api('/api/action',{type:'dagger:bestow',token:myToken,target:p.uid});
        poll();
      });
      li.appendChild(btn); list.appendChild(li);
    });
  }

  if(state.puzzle && state.puzzle.solved){
    $('#puzzleForm').classList.add('hidden'); $('#puzzleForm').innerHTML='';
    $('#btnSubmitPuzzle').classList.add('hidden');
    $('#puzzleResult').textContent = 'You solved it! Your reward has been applied quietly.';
  } else if(!currentQuiz){
    startPuzzle();
  }
}

async function startPuzzle(){
  const r = await api('/api/action', { type:'puzzle:request', token: myToken });
  if(!r.ok) return;
  currentQuiz = r.questions;
  const form = $('#puzzleForm'); form.classList.remove('hidden'); form.innerHTML='';
  currentQuiz.forEach(q=>{
    const div=document.createElement('div'); div.className='q';
    div.innerHTML = '<span>'+q.a+' '+q.op+' '+q.b+' =</span>';
    const input=document.createElement('input'); input.type='number'; input.dataset.id=q.id;
    div.appendChild(input); form.appendChild(div);
  });
  $('#btnSubmitPuzzle').classList.remove('hidden');
  $('#puzzleResult').textContent = '';
}
document.getElementById('btnSubmitPuzzle').addEventListener('click', async ()=>{
  if(!currentQuiz) return;
  const answers = $$('#puzzleForm input').map(i=>({ id: Number(i.dataset.id), value: i.value }));
  const r = await api('/api/action', { type:'puzzle:submit', token: myToken, answers });
  if(!r.ok) return;
  if(r.result.allCorrect){
    currentQuiz = null;
    poll();
  } else {
    $('#puzzleResult').textContent = 'Not quite (' + r.result.correct + '/' + r.result.total + '). Try again -- no rush.';
    currentQuiz = null;
    startPuzzle();
  }
});

function renderLog(){
  ['#revealLog', '#narratorLog'].forEach(sel=>{
    const el=$(sel); if(!el) return; el.innerHTML='';
    (state.log||[]).forEach(entry=>{ const d=document.createElement('div'); d.className='msg'; d.textContent=entry.text; el.appendChild(d); });
    el.scrollTop = el.scrollHeight;
  });
}

function phaseLabel(p){
  return { 'lobby':'Waiting in the lobby','night-mafia':'Night -- the Family decides','night-doctor':'Night -- the Doctor decides','night-detective':'Night -- the Detective investigates','night-resolve':'Night -- resolving','day-discuss':'Day -- open discussion','day-vote':'Day -- voting','day-revote':'Day -- re-vote (tied)','ended':'Game over' }[p] || p;
}

function renderNarrator(){
  const phase = state.phase || 'lobby';
  $('#narratorPhaseLabel').textContent = phaseLabel(phase);
  $('#narratorLink').textContent = 'Guests join at: ' + location.origin + '/';
  $('#narratorLobbyBox').classList.toggle('hidden', phase!=='lobby');
  $('#narratorStatusBox').classList.toggle('hidden', phase==='lobby' || phase==='ended');
  $('#narratorEndBox').classList.toggle('hidden', phase!=='ended');
  renderLog();
  if(phase==='lobby') renderNarratorLobby();
  else if(phase==='ended') renderNarratorEnd();
  else renderNarratorStatus();
}

function renderNarratorLobby(){
  const list=$('#narratorLobbyList'); list.innerHTML='';
  (state.players||[]).forEach(p=>{ const li=document.createElement('li'); li.innerHTML='<span>'+esc(p.codeName)+'</span>'; list.appendChild(li); });
  $('#btnStartGame').disabled = (state.players||[]).length < 5;
}
document.getElementById('btnStartGame').addEventListener('click', async ()=>{ await api('/api/action',{type:'narrator:start',token:myToken}); poll(); });

function renderNarratorStatus(){
  const list=$('#narratorStatusList'); list.innerHTML='';
  const continueBtn=$('#btnNarratorContinue'), callVoteBtn=$('#btnCallVote');
  continueBtn.classList.add('hidden'); callVoteBtn.classList.add('hidden');
  continueBtn.textContent = state.phase==='night-resolve' ? 'Reveal' : 'Continue';

  const s = state.status || {};
  if(state.phase === 'day-discuss'){
    callVoteBtn.classList.remove('hidden');
    callVoteBtn.onclick = async ()=>{ await api('/api/action',{type:'narrator:callVote',token:myToken}); poll(); };
    list.innerHTML = '<li><span>Open floor. Call the vote when ready.</span></li>';
    return;
  }

  (s.entries||[]).forEach(e=>{
    const li=document.createElement('li');
    li.innerHTML = '<span>'+esc(e.label)+'</span><span class="'+(e.done?'done':'waiting')+'">'+(e.done?'ready \u2713':'deciding...')+'</span>';
    list.appendChild(li);
  });
  if((s.entries||[]).length===0 && state.phase==='night-resolve'){
    list.innerHTML = '<li><span>Ready to reveal what happened in the night.</span></li>';
  }

  continueBtn.classList.remove('hidden');
  continueBtn.disabled = !s.ready;
  continueBtn.onclick = async ()=>{
    if(state.phase==='day-vote' || state.phase==='day-revote'){
      await api('/api/action',{type:'narrator:resolveVote',token:myToken});
    } else {
      await api('/api/action',{type:'narrator:continue',token:myToken});
    }
    poll();
  };
}

function renderNarratorEnd(){
  $('#narratorGameOverTitle').textContent = state.winner==='town' ? 'The Town Wins.' : 'The Mafia Wins.';
}
document.getElementById('btnNewGame').addEventListener('click', async ()=>{
  if(!confirm('Start a brand new game? Everyone will need to rejoin.')) return;
  await api('/api/action',{type:'narrator:newGame',token:myToken});
  poll();
});
`;

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------

function localIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('\nThe Underworld is running.\n');
    console.log('On this computer: http://localhost:' + PORT);
    const ips = localIPs();
    if (ips.length) {
      console.log('For guests on the same WiFi:');
      ips.forEach(ip => console.log('  http://' + ip + ':' + PORT));
    } else {
      console.log('Could not detect a local WiFi IP -- check your network connection.');
    }
    console.log('');
  });
}

module.exports = { server, game: () => game, resetGame: () => { game = freshGame(); } };
