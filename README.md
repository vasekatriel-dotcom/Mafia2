# The Underworld — single-file edition

Real multiplayer Mafia for 15–20 people on their own phones, same WiFi as
your computer, **zero setup**: no Firebase, no GitHub, no `npm install`.
Just Node.js and one command.

## Why this instead of a static HTML file

A plain `.html` file opened by double-clicking has no way to talk to other
phones — there's no shared state without a server somewhere. This is the
simplest thing that can actually deliver real multiplayer: **one Node.js
file that IS the server**, serving the whole game (HTML/CSS/JS all
embedded) and holding all the secret game state (roles, votes) safely on
your computer, never trusting any phone's browser with data it shouldn't
see.

## Files

```
underworld.js   <- run this. Server + embedded frontend, all in one file.
logic.js        <- pure game-rule functions logic.js requires, unit-tested
names.js        <- the 1920s code-name pool
```

`underworld.js` uses **zero npm packages** — only Node's built-in `http`,
`crypto`, and `os` modules. There is nothing to install.

## Run it

You need [Node.js](https://nodejs.org) installed (any recent version — 18+).

```bash
node underworld.js
```

You'll see something like:

```
The Underworld is running.

On this computer: http://localhost:4000
For guests on the same WiFi:
  http://192.168.1.42:4000
```

- **Open the `localhost` link yourself** and tap "I'm the Narrator" — that makes you the host.
- **Send the other link** (the `192.168.x.x` one) to everyone via WhatsApp, or just tell them to type it in. It only works for phones on the **same WiFi network** as your computer.
- Want a different port? `PORT=5000 node underworld.js`.

Leave the terminal window open for the whole game — closing it stops the server (and, since state lives in memory, ends the game; that's the tradeoff for zero setup).

## Playing

1. You tap **I'm the Narrator**. Everyone else opens the link, types their real name, taps **Enter the speakeasy**, and gets a private 1920s code name.
2. Once at least 5 guests have joined, you get a **Start Game** button.
3. Narrate out loud while your dashboard shows who's still deciding at each step; tap **Continue** once everyone required has acted.
4. During the day, tap **Call the Vote** when you're ready to move from discussion to actual voting.
5. A tied vote automatically restricts the re-vote to just the tied names — tap Continue again once that's in.
6. **No timers, anywhere.** Every phase waits for real input and for you to tap Continue.
7. When it ends, tap **Start a New Game** to reset for another round (guests rejoin with the same link).

## The rules, exactly as built

- Roughly 1-in-5 players are Mafia (e.g. 4 of 20), 1 Doctor, everyone else Villager.
- Detective is **never** assigned at the start. The instant living plain-Villager count drops to exactly 6, one random living Villager becomes Detective — **permanently** (not just for one round), and this only ever happens once per game.
- Mafia kill tiebreak: **whoever was named first wins**, full stop — not a majority count. If Mafia disagree, the earliest submitted target dies.
- Day-vote ties trigger a re-vote restricted to only the tied names, repeating until unique.
- Reveal wording is exact: `"<name> kicked the bucket."` / `"<name> was indeed the mafia."` / `"Alas! <name> is not the mafia."`
- Eliminated players get 10 addition/subtraction questions, no time limit, must get all 10 right (unlimited retries until solved). Town-side success gives the Doctor a one-time extra save; Mafia success gives a dagger that doubles a chosen living player's next day-vote. Both are announced anonymously — never who earned it.
- The Narrator only ever sees pacing status (who's still deciding, ready/not-ready) — **never anyone's actual role or vote**. Only your own browser session (the Narrator's) computes and applies resolutions server-side; this is real server-side secrecy, stronger than what a pure static-site + client database setup can offer, because the server itself holds the only copy of the secret data.

## Testing the game logic without a party

`logic.js` has zero dependencies on the server or DOM, so you can sanity-check the rules directly:

```bash
node -e "
const G = require('./logic.js');
console.log(G.assignRoles(['a','b','c','d','e','f','g','h','i','j']));
console.log(G.dayLynchMessage('Cecil', true));
"
```

## Customizing

- **Code-name pool**: edit `names.js`.
- **Role ratio, math-quiz difficulty, reveal wording**: edit the functions in `logic.js`.
- **Colors, fonts, the cheetah-print accent**: the `CSS` constant near the top of `underworld.js` (CSS variables at the very top of that block control the palette).

## Known limitations (being upfront)

- **State is in-memory.** If the server process restarts, the game resets. Fine for a one-night party; not meant for anything long-running.
- **One game at a time.** This version doesn't support multiple simultaneous parties on different links — it's built for exactly the "one host, one party, one WiFi" scenario you asked for.
- **Reconnection** works via a token saved in each guest's browser (`localStorage`) — reopening the same link on the same phone restores their code name, role, and status, as long as the server process hasn't restarted.
