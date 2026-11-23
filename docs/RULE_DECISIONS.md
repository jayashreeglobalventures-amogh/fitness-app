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
| Rest days | Declared before 10:00 on the day or any earlier time; cancelable until 10:00 that day; not on a day with evidence or inside an exemption request. Admin corrections keep the weekly/total limits; the time is optional (owner, 2026-11-23) - without one the admin is vouching it was declared in time. |
| Exemption requests | Up to 14 days per request; past days allowed (the vote/admin is the safeguard); no overlap with other requests, rest days, or days already achieved. The reason is shown to voters; evidence only to admins. |
| Exemption voting | Voters = participants active on the day of the request (the requester only if the settings allow). Votes can be changed until the window closes. It closes early when everyone has voted. Approved if approve-share ≥ threshold; a tie or fewer votes than the minimum → admin. The voting settings are copied onto the request, so a later rules change can't alter a live vote. |
| Corrections (admin records for someone) | Owner, 2026-11-23: as simple as possible - pick the day (+ screenshot for evidence); original time and note are optional; if the admin types the steps, the screenshot is approved at once with that number (no Review task, 2026-11-23). Without a time, evidence counts as sent at 23:59 that day (now, if today) and a rest day as declared in time; the admin's name is in the activity log. Evidence goes through the normal check. |
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

## Phase 4 money - owner rulings (20 Nov 2026), in Calamari's settings

| Topic | Ruling | Setting |
|---|---|---|
| Money left in a fine pool when the week closes | **Refunded to the participant** (paid out with settlement). Alternatives available: the prize pool, or a separate year-end pool | `finance.unusedFinePool = REFUND` |
| Late contribution | Due on the week's Sunday; **2-day grace**, then shown as overdue with reminders; fines still count against what they owe; **never affects points** | `finance.graceDays = 2` |
| Withdrawal / removal money | **Admin decides each case**; a Finance Admin proposes a refund, a different Super Admin approves; only then is it owed | refund proposals |
| Payments before Phase 4 went live | Reported later with the **original UTR and date**; a Finance Admin confirms | payment `paidOn` may be in the past |

Defaults applied where nothing was said:

| Topic | Default |
|---|---|
| Fines | ₹100 per missed eligible day (no evidence, below target, rejected), never more than the week's fine pool has left; rest days and approved exemptions cost nothing; a day still undecided isn't fined until decided |
| When a week closes | When its last day is over and every day of it is decided |
| Late joiner / leaver | Owes the weeks they take part in (any day of the week), full amount for that week - an admin can refund a part |
| Duplicate UTR | Refused while the earlier report is pending or confirmed |
| Who confirms | Finance Admin or Super Admin; never their own payment |
| What participants see | Their own statement, the payment details, and the pool totals |

## Phase 5 prizes and settlement - owner rulings (20 Nov 2026), in Calamari's settings

| Topic | Ruling | Setting |
|---|---|---|
| Prize pool split | **70 %** to everyone who qualifies (≥ 80 % adherence), **30 %** to the top three | `prizes.qualificationPoolPct = 70`, `topThreePct = 30` |
| Top three | **50 / 30 / 20** | `prizes.topThreeSplitPct` |
| Qualification pool | Shared **equally** | `prizes.distribution = EQUAL` |
| Top-three person not eligible | Skipped: **the next eligible person moves up** | `prizes.topThreeIneligible = NEXT_ELIGIBLE` |

Defaults applied where nothing was said:

| Topic | Default |
|---|---|
| Rounding | Amounts in paise; every split by the largest-remainder method, so parts always add up to the pool exactly |
| Fewer than three eligible | Empty places' money goes to the qualification pool |
| Ties that touch a prize place | Never decided automatically: the app shows the options (share equally - recommended - or an admin-set order) and an admin records the choice and the reason |
| Nobody qualifies | The money stays unallocated; the approving Super Admin must record what happens to it |
| Unpaid contributions at the end | Not blocking; deducted from what that person receives (set-off); anything beyond stays owed |
| Approval | Super Admin only; only when every blocking check passes and nothing changed since the draft; then frozen |
| Corrections after approval | A new version with a reason; replaces the old one when approved; money already paid is never paid twice |

## Admins and the finance manager - owner rulings (21 Nov 2026)

| Topic | Rule |
|---|---|
| Challenge admins | Any admin (or Super Admin) can make other users admins - **no limit**. A challenge needs **at least 2** to be published and can't drop below 2, so nothing depends on one person |
| Two-person rule | (Updated 23 Nov 2026) A payment the finance manager records **for someone else** counts straight away (logged under their name); a payment an admin records or reports **for themselves** is confirmed by a **different** admin. UTR and "where it was reported" are optional when an admin records a payment. Settings → Money → "UTR mandatory when participants report a payment" (default on) decides it for participants. A refund is approved by an admin other than the one who proposed it |
| Finance manager | **Exactly one** per challenge. The first is appointed directly; changing it is a **handover** started by an admin (checks: money held, payment reports and refunds still waiting; the admin confirms the money is being handed over). The **new manager confirms the exact amount received and that the accounts are settled**; only then does the role move. The old UPI ID / QR are hidden from participants until the new manager enters theirs |
| Admin as finance manager | Allowed (owner, 21 Nov 2026). The handover checks still apply, and the two-person rule still covers their own money requests |

## Community feed (Phase 6, 21 Nov 2026)

| Topic | Rule |
|---|---|
| Who sees it | Each challenge has its own feed, seen only by its participants and admins (Super Admins see all). Settings → Community: on/off, whether participants may post, whether photos are allowed |
| Posting | Active participants post text and/or a photo; admins post **announcements**, which are pinned and show in everyone's Alerts for 7 days. Limits: 20 posts and 200 comments a day per person |
| Achievements | Shared from the person's own streaks, comebacks and weekend bonuses; the text is generated from the points event, so steps, health data and money never appear |
| Comments | One level of replies; people delete their own posts and comments (hidden, not erased) |
| Reactions | 👍 ❤️ 🔥 👏 💪, tap again to take back |
| Moderation | Challenge admins (not the finance manager) pin, remove with a recorded reason (audited), handle reports (remove or dismiss), and mute someone for 1–30 days (they can still read and react) |

## Phone notifications and the activity log (owner, 21 Nov 2026)

| Topic | Rule |
|---|---|
| Phone notifications | Each person switches them on or off in Profile (off until they choose). On = this phone asks permission and registers; Off = stops on all their phones. iPhone: only for the app added to the Home Screen (iOS 16.4+) |
| What is sent | Every new alert from the Alerts tab, once (alerts already there when switching on, or already read in the app, are not sent); more than 3 at once become one summary. Tapping opens the app on Alerts, signing in first if needed |
| Privacy | The lock screen shows only the alert's title, never the details |
| Activity log | Super Admins only (People → Activity log): every recorded action with who, what, when, which challenge, reason, before → after, IP address and device; filters, search, CSV download. Entries can't be edited or deleted |
| Sign-ins | Successful, failed and locked-out sign-ins and sign-outs are recorded. For an unknown username nothing typed is kept |
| Errors | Unexpected server errors and failed background work are recorded (person, page, device) and kept 180 days |

## WhatsApp reminders (owner, 21 Nov 2026: option 2 - free, sent by an admin)

| Topic | Rule |
|---|---|
| How | No paid service or API key. Team tab (today): "📲 Remind" opens the admin's own WhatsApp with an editable message to that person; "Message the group" opens it with one message naming everyone still pending, to send to the challenge group |
| Who is listed | Active participants with no screenshot yet today, or whose screenshot was rejected |
| Numbers | The mobile number from the person's account (entered by the admin, or by them in Profile); a 10-digit number is taken as Indian (+91). Only admins who manage the roster see numbers (not the finance manager) |
| Record | Each reminder is recorded in the activity log and shown on the row ("Reminded 8:40 pm by …") so admins don't repeat each other. The app can't see whether the message was actually sent |
| Later | Automatic WhatsApp (Meta WhatsApp Business API, ~₹0.12–0.15 per message, needs a Meta business account and number) can be added if wanted |

## Health profile (Phase 7, 21 Nov 2026 - per the PRD's privacy rules)

| Topic | Rule |
|---|---|
| Optional, consent first | Nothing is collected until the person agrees (consent v1, recorded). Taking part in a challenge never requires it |
| What | Height, weight, BMI (calculated: kg ÷ m², shown as a screening number only), body fat %, waist, resting heart rate; fitness level, activity level, goals, targets, health considerations |
| History | Every entry is dated and kept; new entries never overwrite old ones; the owner can correct or delete an entry. Progress chart per measure |
| Visibility | Per field: Only me (default) / My challenge admins / My challenge members / Everyone in the app. Health considerations at most challenge admins. A public basic profile never makes health data public |
| Roles | Challenge admins see only fields shared with admins (or wider), of people in their challenges. The finance-manager and Super Admin roles grant nothing |
| Support access | Granted by the person to one Super Admin for 1, 4, 24 or 72 hours; can be stopped any time; every view is in the activity log |
| Withdraw / delete | Withdrawing consent stops all sharing at once (records kept hidden, or erased if chosen); "Delete all" erases everything permanently |
| Enforcement | In the database: row-level security lets the app's connection read only the signed-in person's health rows; other people's data only via one function that applies their sharing. Values never go into the activity log, notifications, posts or AI |
| Person page | Tapping a name (leaderboard, community) shows what that person shares with you - basic fields per their visibility, health per their health sharing |

## Coach - rule-based (owner, 21 Nov 2026: free, no AI yet; AI can be plugged in later)

| Topic | Rule |
|---|---|
| Weekly summary | After each challenge week, per participant (Today tab + an alert for 3 days): days done vs counted, compared with last week, average and best-day steps, streak, overall adherence vs the prize line (and how many successful days would reach it), points, weakest weekday, one realistic aim |
| Evening nudge | From the challenge's nudge time (Calamari 20:00) if today's steps aren't in: a personal alert ("keep your 9-day streak going", "today's a fresh start") that goes to the phone. Before that, the plain check-in alert is in the app only |
| Needs a hand | Admins see participants with 2+ misses in a row, or below the prize line after 5+ counted days, with the reason and a WhatsApp check-in button (Team tab + a daily alert) |
| Numbers | Streaks and misses in a row are counted exactly as the points engine does (rest days and exemptions pause; stops at an undecided day) |
| Settings | Settings → Coach: each part on/off, nudge time |
| Phone quiet hours | No phone notifications 23:00–07:00 IST; alerts wait in the app and go out at 7 if still unread |
| AI later | The coach works out facts and a "writer" puts them into words. An AI writer can be selected later (COACH_WRITER); it would receive only these facts - no health data, no money details - and the templates take over if it fails |

## Fine-pool carry-over, several screenshots, Today screen (owner, 21 Nov 2026)

| Topic | Rule |
|---|---|
| Fine-pool carry-over | New option "Carried to next week" (CARRY_FORWARD), used by Calamari: when a week closes, what's left in the person's fine pool is credited against their next week, so they pay ₹400 + only the top-up back to ₹600 (e.g. 3 misses ⇒ ₹700). After the last week (or after leaving) the leftover is refunded. Anyone who paid the full amount keeps the extra as credit for later weeks |
| Several screenshots a day | Setting (off by default): each screenshot is read on its own (no target check), auto-approved if the date and number are clear, otherwise Approve / Decline by an admin. The day's total = approved ones added up (different devices) or the highest (same app). Met as soon as the total reaches the target; otherwise decided at midnight. The same picture can't be added twice; up to 10 a day |
| Week start | Locked once the challenge has started (it would reshuffle weeks, money and rest days) - now explained on the setting |
| Today screen | Rest-day planner above the calendar; "My money" rings beside the day's card (my share of the pot; this week's fine pool still mine vs moved to the group); screenshots open in an in-app viewer with ✕ (and Back) |

## Removing a screenshot (owner, 21 Nov 2026)

| Topic | Rule |
|---|---|
| Until midnight | The person removes their own screenshot (Today card / calendar day): the day goes back to "not sent" (or its total drops) and they can upload another |
| After midnight | "Ask to remove" with a reason: it appears in Review → Requests; an admin (not the person) approves - points and fines are recalculated - or declines with a reason |
| The image | Removed = hidden, kept on record. If it's a private photo (the person ticks this), an admin can erase the image permanently; the record stays ("image erased"). Erased images stay in encrypted backups until those expire (up to 12 months) |
| Records | Every removal, request, decision and erase is in the activity log |

## Late joiners: pro-rata prizes (owner, 23 Nov 2026)

| Topic | Rule |
|---|---|
| Measure | Days taken part (joined → end, or the day they left) ÷ the challenge's days (Calamari: 40) |
| Qualifier pool (70%) | Shared in proportion to days taken part (someone in for all days = a full share) |
| Top three (30%) | A late joiner's place money × their share of days; the rest joins the qualifier pool |
| Setting | Settings → Prizes → "Late joiners: prizes in proportion to the days they took part" (on for Calamari; Super Admin) |
| Contributions | Already only for the weeks a person takes part in (unchanged) |

## Still open

**22** Calamari's exemption voting numbers (set in *Settings → Exemptions*; until then every request goes to an admin).
Also: what a **suspended** participant's days count as (today they still count).
