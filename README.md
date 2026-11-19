# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/raditsaputra4004-prog/bountyhawk-gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/raditsaputra4004-prog/bountyhawk-gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, its earn
rate on [Exophase](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/)
at the case's target instant — five quantiles (5%, 25%, 50%, 75%, 95%) per
trophy. Entered on [make.fun](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
(competition `gta6-trophy-rarity-forecast-01`, $250 in USDC).

Referral: `2yq7mcmp` — https://make.fun/r/2yq7mcmp

## The idea

An earn rate is a ratio — earners over players tracked — and both sides
move. On launch night the tracked set is a few hundred hardcore players and
most rates sit near 1%. As the week goes on, the tracked set grows with more
casual players (which drags most rates down) while the players already in
keep playing through the game (which pushes story trophies up). A flat
"rates stay put" forecast is wrong in a systematic direction, and the
direction differs per trophy.

So `main.ts` fits, per trophy, a damped trend of the rate's logit against
log-time (log-time is concave, so a straight line in it already slows
down), with each read weighted by how fresh it is and by how precisely its
rate is measured (a rate from 638 tracked players is far noisier than one
from 50,000), then pulls each trophy's slope toward the mean slope of its
tier and of all trophies, so noisy trophies borrow strength from the group.
The median blends the trend with the last read, the move from the last read
is capped, and the spread combines the horizon's random-walk width, the
slope's own uncertainty, the fit's residuals and the size of the jumps
between past reads — so a history that says nothing (flat launch night)
still gets an honest wide band instead of a confident wrong one.

## Run it

Node 22, standard library only, no network, deterministic (no randomness,
no clock — two runs write the same bytes):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `<id>.in` case file in the input directory and writes one
`<id>.out` per case: `{"trophies": [{"id": 1, "q": [q05, q25, q50, q75,
q95]}, ...]}`, one row per trophy, five non-decreasing quantiles in percent.

## Validation

On the kit's practice cases (`p00`, `p01`) the program runs clean,
deterministic (byte-identical across runs), and writes valid forecasts
(55 rows, 5 non-decreasing quantiles in [0, 100]). Against simulated
refresh answers for the practice cases it beats the house persistence
baseline at every plausible new-joiner earn rate, and on a synthetic
final-style case (two drifting days of history, +4.5-day target) it scores
a mean pinball loss of ~0.17 against the baseline's ~0.94 — the trend
machinery tracks both rising story trophies and falling rare ones.

## License

MIT — see [LICENSE](LICENSE).
