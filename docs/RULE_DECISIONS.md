# Rule decisions

How the app applies the parts of the rules the PRD leaves open. **Defaults** are what the code does today; the owner can
change any of them. **Open** items are not implemented until the owner decides (assessment §11).

## Phase 2 defaults (in force)

| Topic | Default |
|---|---|
| Which day evidence counts for | The day (challenge time zone) the complete upload reaches the server. Never an earlier day. |
| Resubmission | Allowed until midnight while the day isn't verified yet; the new upload replaces the old one (kept as *superseded*). |
| Automatic reading | The reader (free on-server Tesseract, or Claude if a key is set) may only **approve** a clear, confident (≥ the configured confidence, Calamari 0.9), on-target reading of the right day. Below target, unclear date, unreadable, model flags, a total that disagrees with what the participant typed, reused images and reader outages all go to an admin. It never rejects. The free reader also sends weekly/average screens, several dates, several step counts, and "Today" without a date to an admin. |
| Duplicate images | An image already used by anyone else, or by the same person for another day, always goes to an admin. |
| Admin decisions | "Target reached" needs a value ≥ target; "below target" a value < target; "rejected" and any change of decision (including deciding an appeal) need a reason. Nobody reviews their own evidence. |
| Appeals | One appeal per decision (below target or rejected); it goes back to the review queue. |
| Rest days | Declared before 10:00 on the day or any earlier time; cancelable until 10:00 that day; not on a day with evidence or inside an exemption request. Admin corrections keep the weekly/total limits and record the original time (flagged if after 10:00). |
| Exemption requests | Up to 14 days per request; past days allowed (the vote/admin is the safeguard); no overlap with other requests, rest days, or days already achieved. The reason is shown to voters; evidence only to admins. |
| Exemption voting | Voters = participants active on the day of the request (the requester only if the settings allow). Votes can be changed until the window closes. It closes early when everyone has voted. Approved if approve-share ≥ threshold; a tie or fewer votes than the minimum → admin. The voting settings are copied onto the request, so a later rules change can't alter a live vote. |
| Corrections for days before the app is live | Admin records the evidence/rest day with its original time (must be before that day's midnight / is flagged if after 10:00) and a reason; evidence goes through the normal check. |
| Adherence (shown now, provisional) | achieved ÷ (achieved + missed), over days that have happened; rest and excused days are left out; pending days don't count yet. |

## Phase 3 scoring - owner rulings (20 Nov 2026), in Calamari's settings

| Topic | Ruling | Setting |
|---|---|---|
| Missed eligible day (no evidence, below target, rejected) | **−15 in total per missed day**; penalties never stack (Mon, Tue, Wed missed = −45) | `penalties.missedDay` on; `consecutiveMisses` and `teamStreakBreak` off |
| Team streak break | Every miss counts, even when the team streak is already 0 - covered by the −15 per missed day; each break is still **recorded** (date, previous streak, who missed, restart day) | `penalties.teamStreakBreak.when = EVERY_MISS` (kept off, see above) |
| Comeback | **2 or more** misses in a row, then 3 successful days → +10, at most 3 | `comeback.missRun = AT_LEAST` |
| Weekend bonus | Weekend = **Saturday + the following Sunday**; 22 Nov is a one-day weekend | `weekendBonus.weekend = SAT_NEXT_SUN` |

Defaults applied where nothing was said (change in Settings if needed):

| Topic | Default |
|---|---|
| Personal streak milestones after a break | A new streak earns 7/14/21/28/35 again (`personalStreak.repeatAfterBreak = true`) |
| Team streak bonus recipients | Everyone taking part that day, including whoever was on a rest day or excused |
| Undecided days | Sequences (streaks, comebacks, team streak) stop at the first day that is still pending (review, exemption vote, or not over yet) and continue once it is decided; daily points don't wait |
| Corrections | A changed decision appends a reversal (and a new award) to the points ledger - never an edit |
| Leaderboard | Provisional; prize eligibility = adherence ≥ 80 % and not withdrawn/removed/disqualified |

## Still open (need the owner's ruling before money / settlement)

From the assessment §11: **5** withdrawal refunds, **11** top-three when someone is under 80 %, **21** where unused fine
money goes, **22** Calamari's exemption voting numbers (set in *Settings → Exemptions*), **23** late payments. Also: what a
**suspended** participant's days count as (today they still count).
