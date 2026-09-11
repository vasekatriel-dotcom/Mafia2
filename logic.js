// logic.js
// Pure, dependency-free game-rule functions for "The Underworld" -- no
// HTTP, no state mutation. Kept separate from server.js purely so it can
// be unit-tested directly with `node --check` / `require()`, same idea as
// the earlier gameLogic.js. server.js requires this file.

const ROLES = { MAFIA: 'Mafia', DOCTOR: 'Doctor', VILLAGER: 'Villager', DETECTIVE: 'Detective' };

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Roughly 1-in-5 players are Mafia (e.g. 4 of 20), exactly 1 Doctor, the
// rest start as Villager. Detective is carved out later, never here.
function assignRoles(uids, rng = Math.random) {
  const n = uids.length;
  if (n < 5) throw new Error('Need at least 5 players to assign roles.');
  const mafiaCount = Math.max(1, Math.round(n / 5));
  const shuffled = shuffle(uids, rng);
  const roles = {};
  let cursor = 0;
  for (let i = 0; i < mafiaCount; i++) roles[shuffled[cursor++]] = ROLES.MAFIA;
  roles[shuffled[cursor++]] = ROLES.DOCTOR;
  for (; cursor < shuffled.length; cursor++) roles[shuffled[cursor]] = ROLES.VILLAGER;
  return roles;
}

// "Kill whoever was voted for first" -- earliest-timestamped vote's target
// wins outright, not a majority count. votes: [{ uid, target, ts }]
function resolveMafiaKill(votes) {
  if (!votes || votes.length === 0) return null;
  return votes.slice().sort((a, b) => a.ts - b.ts)[0].target;
}

// Day-vote tally + tiebreak: a tie triggers a re-vote restricted to only
// the tied candidates. votes: [{ uid, target }]
function tallyDayVotes(votes) {
  const counts = new Map();
  for (const v of votes) counts.set(v.target, (counts.get(v.target) || 0) + 1);
  if (counts.size === 0) return { tie: false, winner: null };
  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.entries()).filter(([, c]) => c === maxCount).map(([t]) => t);
  if (tied.length === 1) return { tie: false, winner: tied[0] };
  return { tie: true, candidates: tied };
}

// One-time, ONWARD (permanent) Detective promotion the instant living
// plain Villagers drops to exactly 6. Never reverts, never re-triggers.
function maybeActivateDetective(players, alreadyActivatedEver, rng = Math.random) {
  if (alreadyActivatedEver) return null;
  const living = Object.entries(players).filter(([, p]) => p.alive && p.role === ROLES.VILLAGER).map(([uid]) => uid);
  if (living.length !== 6) return null;
  return living[Math.floor(rng() * living.length)];
}

function checkWinCondition(players) {
  const alive = Object.values(players).filter(p => p.alive);
  if (alive.length === 0) return null;
  const mafiaAlive = alive.filter(p => p.role === ROLES.MAFIA).length;
  const townAlive = alive.length - mafiaAlive;
  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= townAlive) return 'mafia';
  return null;
}

function nightKillMessage(codeName) { return `${codeName} kicked the bucket.`; }
function noOneKilledMessage() { return 'The city holds its breath -- no one was killed tonight.'; }
function dayLynchMessage(codeName, wasMafia) {
  return wasMafia ? `${codeName} was indeed the mafia.` : `Alas! ${codeName} is not the mafia.`;
}

// 10 addition/subtraction questions, no multiplication/division, subtraction never negative.
function generateMathQuestions(count = 10, rng = Math.random, max = 12) {
  const qs = [];
  for (let i = 0; i < count; i++) {
    const op = rng() < 0.5 ? '+' : '-';
    let a = 1 + Math.floor(rng() * max);
    let b = 1 + Math.floor(rng() * max);
    if (op === '-' && b > a) [a, b] = [b, a];
    qs.push({ id: i, a, b, op, answer: op === '+' ? a + b : a - b });
  }
  return qs;
}
function gradeMathQuiz(questions, submitted) {
  let correct = 0;
  for (const q of questions) {
    const g = submitted.find(s => s.id === q.id);
    if (g && Number(g.value) === q.answer) correct++;
  }
  return { correct, total: questions.length, allCorrect: correct === questions.length };
}

function pickAvailableName(pool, used) {
  const avail = pool.filter(n => !used.includes(n));
  if (avail.length === 0) return null;
  return avail[Math.floor(Math.random() * avail.length)];
}

module.exports = {
  ROLES, shuffle, assignRoles, resolveMafiaKill, tallyDayVotes, maybeActivateDetective,
  checkWinCondition, nightKillMessage, noOneKilledMessage, dayLynchMessage,
  generateMathQuestions, gradeMathQuiz, pickAvailableName
};
