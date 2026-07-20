---
name: claudepilot-agents
description: Créer et piloter des agents Claude Code isolés via le serveur claudepilot (worktrees git, prompts, dialogs, diff). Utiliser quand l'utilisateur veut déléguer une tâche à un agent claudepilot, lancer des agents en parallèle, ou inspecter/piloter des sessions claudepilot existantes.
---

# Piloter des agents claudepilot

Toutes les opérations passent par le thin client livré avec cette skill :

```bash
node .claude/skills/claudepilot-agents/pilotctl.mjs <commande> …
```

Chaque commande imprime UN objet JSON sur stdout (exit 1 + `{error}` en
échec) et démarre automatiquement le serveur claudepilot s'il ne tourne pas
(port 3789, ou `$CLAUDEPILOT_PORT`). Les sessions restent visibles dans
l'UI web (http://localhost:3789) — l'utilisateur peut suivre et intervenir.

## Commandes

| Commande | Effet |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--resume ID] [--continue]` | crée un agent → `{sessionId, cwd, branch}`. `--worktree` isole l'agent dans un worktree git (`~/.claudepilot/worktrees/`, branche `claudepilot/<tag>`) |
| `prompt <id> "texte" [--timeout s]` | envoie un prompt, attend la fin du tour → `{status:"answer", text, tools}` ou `{status:"dialog", question, options, multi}` ou `{status:"timeout", screen}` |
| `dialog <id>` | interroge l'état → `{status:"idle"}` ou le dialog en attente |
| `choose <id> <n>` | dialog single-select : choisit et valide l'option n |
| `toggle <id> <n>` puis `confirm <id>` | dialog multi-select : coche/décoche puis soumet |
| `freetext <id> <n> "texte"` | option « Type something » : réponse libre |
| `list [--cwd DIR]` | agents pilotés (état local + vivant/mort) et sessions résumables |
| `diff <id>` | changements de l'agent (git status + diff vs la base du worktree) |
| `stop <id>` | termine la session (pour TOUS ses clients) |
| `screen <id>` | screen TUI brut (debug) |

## Flux type : déléguer une tâche à un agent

1. `spawn --worktree --cwd <repo>` → noter `sessionId` et `branch` ;
2. `prompt <id> "<tâche>"` — lancer via Bash en **run_in_background**
   (un tour peut durer plusieurs minutes) et lire le JSON à la fin ;
3. si `status:"dialog"` : répondre avec `choose` (single) ou
   `toggle`+`confirm` (multi) ou `freetext`, qui rendent à leur tour
   `answer` ou un nouveau `dialog` ;
4. si `status:"timeout"` : le tour CONTINUE côté serveur — ne pas renvoyer
   le prompt ; re-vérifier plus tard avec `dialog <id>` ;
5. tâche finie : `diff <id>` et présenter les changements à l'utilisateur.
   La branche `claudepilot/<tag>` et son worktree ne sont JAMAIS mergés ni
   supprimés automatiquement — c'est l'utilisateur qui merge.

Agents parallèles : répéter `spawn` (un id par agent), lancer les `prompt`
en arrière-plan simultanément.

## Garde-fous

- Ne JAMAIS `stop` une session que cette conversation n'a pas créée : elle
  appartient peut-être à l'utilisateur dans l'UI web. `stop` termine la
  session pour tous ses clients.
- Chaque agent consomme le quota Claude comme une session normale. Ne pas
  multiplier les agents sans demande explicite de l'utilisateur.
- `prompt` sur une session dont le tour est déjà en cours → erreur « a
  response is already in progress » : attendre avec `dialog <id>`.
- Si un agent semble bloqué sur un état que les dialogs ne couvrent pas,
  regarder `screen <id>` (équivalent de l'« engine room » de l'UI).

## Mécanique (pour le debug)

Le serveur tue le process claude quand son dernier client WS se détache ;
`pilotctl` maintient donc un petit process « holder » détaché par agent
(commande interne `hold`), relancé au besoin par chaque commande. État
local : `~/.claudepilot/pilotctl/<id>.json` (cwd, branch, baseSha,
holderPid). Log du serveur auto-démarré : `~/.claudepilot/pilotctl/server.log`.
