// The Help content: every feature, who it's for, how to use it, with examples. Plain text (with **bold**) so the
// Help page can search all of it. Keep in step with the app and docs/RULE_DECISIONS.md when features change.
// Numbers quoted for Calamari are its settings as of 21 Nov 2026; each challenge's Rules tab is the source of truth.

export type Audience = 'everyone' | 'admin' | 'finance' | 'super';
export type Block = string | { list: string[] } | { steps: string[]; title?: string } | { example: string[]; title?: string } | { tip: string };
export interface Topic { id: string; group: string; audience: Audience[]; title: string; keywords?: string; body: Block[] }

export const GROUPS = ['Getting started', 'Daily check-in', 'Points & progress', 'Money', 'Community & profile', 'For admins', 'For the finance manager', 'For Super Admins'];

export const TOPICS: Topic[] = [
  // ---------- Getting started ----------
  { id: 'sign-in', group: 'Getting started', audience: ['everyone'], title: 'Signing in and your password', keywords: 'login password temporary account forgot',
    body: [
      'An admin creates your account and gives you a **username** and a **temporary password**. At your first sign-in you choose your own password (at least 10 characters).',
      'Change it any time: **Profile → Change password**. Forgot it? Ask an admin to reset it - you get a new temporary password.',
      { tip: 'After 5 wrong attempts sign-in is paused for 15 minutes for that username - just wait, or ask an admin.' },
    ] },
  { id: 'install', group: 'Getting started', audience: ['everyone'], title: 'Installing the app on your phone', keywords: 'home screen pwa iphone android install',
    body: [
      'Fitness is a web app you add to your Home Screen - no app store needed.',
      { steps: ['**iPhone:** open the link in **Safari** → tap **Share** → **Add to Home Screen** → open Fitness from the icon.',
        '**Android:** open the link in **Chrome** → tap **Install app** (or ⋮ → Add to Home screen).'] },
      { tip: 'On iPhone, phone notifications only work in the installed app, not in Safari.' },
    ] },
  { id: 'notifications', group: 'Getting started', audience: ['everyone'], title: 'Phone notifications and Alerts', keywords: 'push notification alerts badge quiet hours test',
    body: [
      '**Alerts** (bottom bar) lists what needs your attention: today\'s check-in, payments due, votes, announcements, the coach\'s weekly summary. Opening an alert marks just that one as read; **Mark all as read** clears them all.',
      'To get them on your phone: **Profile → Phone notifications → Turn on**, allow it when the phone asks, then **Send a test**. **Turn off** stops them on all your phones.',
      { list: ['**Quiet hours:** nothing is sent during the challenge\'s quiet hours (Calamari: **11 pm to 7 am**); alerts wait and arrive when they end, if still unread.',
        'The lock screen shows only a short title, never your details.',
        'The plain "today\'s check-in" alert stays in the app; the **step reminders** (at the times the admins set, only if your steps aren\'t in) are what reach your phone.'] },
      '**Choose what you get:** Profile → Phone notifications → **Choose what you get**. Switch off kinds you don\'t want (step reminders, rest-day reminder, screenshot decisions, streaks and leaderboard moves, team streak, weekly summary, payments, comments) - or switch **new community posts** on (off unless you choose it). Invitations, votes, announcements and payments due always come.',
      { list: ['**Screenshot decided:** when an admin approves or declines your screenshot.', '**🔥 Streaks and moving up:** streak milestones, and each morning if you moved up the leaderboard.',
        '**Team streak:** in the evening, once your steps are in, how many still need to upload.', '**Payments:** the day before a contribution is due, and when your payment is confirmed.'], },
    ] },
  { id: 'notification-settings', group: 'For admins', audience: ['admin'], title: 'Notification settings for a challenge', keywords: 'notifications reminders times digest round-up quiet hours admin alerts community posts',
    body: [
      '**Calamari → Settings → Notifications** decides what may go to phones for this challenge (everything also shows under Alerts in the app).',
      { list: ['**Reminders to upload steps:** one or more times a day (up to 6), only to people whose steps aren\'t in and who aren\'t resting or excused. Plus an optional morning **rest-day reminder** before the cut-off.',
        '**Admin alerts:** switch each kind on or off (screenshots to review, payments, exemptions, bonuses, reports) and choose **straight away** or a **round-up** at set times (e.g. 9:00 and 18:00). Switched-off kinds still show under Alerts.',
        '**Community:** comments on people\'s posts; **new posts** grouped into one alert - each person turns that on for themselves.',
        '**Good news and reminders:** screenshot decisions, streak milestones, leaderboard moves, payment confirmed, contribution due tomorrow, and the evening team-streak alert (from a time you choose).',
        '**Quiet hours:** nothing reaches phones in between; alerts wait until they end.'] },
      { example: ['Reminders at **12:00, 18:00 and 21:30** → someone who hasn\'t uploaded gets three nudges; someone who uploaded at 11 gets none.', 'Admin alerts as a round-up at **9:00 and 18:00** → a screenshot sent at 13:00 shows in Alerts at once and buzzes admins\' phones at 18:00.'], title: 'Examples' },
      { tip: 'Each person can still switch kinds off in Profile → Phone notifications → Choose what you get.' },
    ] },

  // ---------- Daily check-in ----------
  { id: 'apple-health', group: 'Daily check-in', audience: ['everyone', 'admin'], title: 'Steps straight from Apple Health (iPhone)', keywords: 'apple health iphone shortcut sync automatic steps key automation watch',
    body: [
      'On iPhone, an **Apple Shortcut** can send today\'s steps from the Health app to Fitness - no screenshot needed. Screenshots still work too.',
      { title: 'Step 1 - add the Shortcut (once)', steps: [
        'On your iPhone, open Fitness: **Profile → 📱 Steps from Apple Health → Set up on this iPhone**. Your key is copied and a page with the Shortcut opens.',
        'Tap **Open in Shortcuts**, then **Set Up Shortcut**, tap the box → **Paste**, then **Add Shortcut**.',
        'Fitness is left on a black page with no Back button (this only happens during setup): **close Fitness** - swipe up from the bottom, then swipe Fitness away - and open it again.',
        'Once: iPhone **Settings → Apps → Shortcuts → Advanced** → turn on **Allow Sharing Large Amounts of Data** (on iOS 17 and older, Shortcuts is in the main Settings list). Without it the iPhone refuses to send a day\'s worth of step readings ("…is trying to share 588 Health items, which is not allowed").',
        'Also once: open the **Shortcuts** app and tap the **Send steps to Fitness** tile. The iPhone asks to read **Steps** - tap **Allow**. (It can only ask there, not from Sync now or the automation.)',
        'Back in Fitness, tap **🔄 Sync now**. You should see a note like "Calamari: 9,136 steps saved…"; tap **◀ Fitness** to come back.'] },
      { title: 'Step 2 - make it run every night (iOS 17 and newer)', steps: [
        'Check your version: **Settings → General → About → iOS Version**.',
        'Open the **Shortcuts** app and tap **Automation** at the bottom.',
        'Tap **+** at the top right (or **New Automation** in the middle if you have none yet).',
        'Scroll and tap **Time of Day**.',
        'Tap the time and set **11:30 PM**. Under **Repeat** choose **Daily**. At the bottom choose **Run Immediately** (not "Run After Confirmation"). Optional: switch off **Notify When Run**.',
        'Tap **Next** (top right).',
        'Under **My Shortcuts** tap **Send steps to Fitness** (or type its name in the search bar). It is saved - you\'ll see "At 11:30 PM, daily" in the list.'] },
      { title: 'Step 2 - make it run every night (iOS 16)', steps: [
        'Shortcuts → **Automation** → **Create Personal Automation** (or **+** → Create Personal Automation).',
        '**Time of Day** → set **11:30 PM** → **Daily** → **Next**.',
        '**Add Action** → search **Run Shortcut** → tap it → tap the blue word **Shortcut** → choose **Send steps to Fitness** → **Next**.',
        'Switch **off** "Ask Before Running" → **Don\'t Ask** → **Done**.'] },
      { tip: 'Want the race track to fill in during the day too? Add a second automation the same way (e.g. 8:00 PM) - a later sync raises the count, never lowers it. Or tap **Sync now** in Profile any time.' },
      { tip: '**"…trying to share … Health items, which is not allowed"?** iPhone **Settings → Apps → Shortcuts → Advanced** → turn on **Allow Sharing Large Amounts of Data**.' },
      { tip: '**"Health gave no step readings"** (or "0 readings")? Shortcuts isn\'t allowed to read Steps - iOS then gives it nothing, without an error. iPhone **Settings → Privacy & Security → Health → Shortcuts** → turn on **Steps**, then run it once from the Shortcuts app. Also check your steps show in the **Health** app (Browse → Activity → Steps).' },
      { tip: '**"Authorization not determined"?** Run it once from the Shortcuts app (tap its tile) and tap **Allow**. Still there? iPhone **Settings → Privacy & Security → Health → Shortcuts** → turn on **Steps**.' },
      { tip: '**Sync now** says the Shortcut **doesn\'t exist**? The name doesn\'t match - an iPhone calls a second copy "Send steps to Fitness 1". Delete older copies and long-press the right one → **Rename** to **Send steps to Fitness**, or tap **Change** under Sync now and type the name exactly as the tile shows it.' },
      { list: ['**Reaching the target** with synced steps meets the day - even if a screenshot was declined.', 'Below the target, the day shows **in progress** until midnight, then it is missed (unless a screenshot meets it).',
        'On a **rest day** nothing is sent. Steps only count for the day they are sent, before midnight.',
        '**Admins** see 📱 and the number in **Team**. **Doubt** stops it counting and asks the person for a screenshot (an admin records it with Correct if the day is over); **Accept** makes it count again.'] },
      { tip: 'Check the number matches your Health app the first time. If your watch and phone both count steps, "Group By: Day" stops them being counted twice.' },
      { tip: 'Lost your phone or shared the key by mistake? Profile → Make a new key (the old one stops working) or Stop syncing.' },
    ] },
  { id: 'upload', group: 'Daily check-in', audience: ['everyone'], title: 'Uploading today\'s screenshot', keywords: 'screenshot upload steps evidence deadline midnight date total today no date duplicate same screenshot',
    body: [
      'Each day, upload a screenshot of your step total **before midnight** (India time): **Challenges → Calamari → Today → Upload today\'s screenshot**. Evidence counts only for the day it is uploaded.',
      'The app reads the number and date automatically. A clear screenshot of **today\'s date** that reaches the target is approved at once; anything unclear goes to an admin.',
      { tip: 'Use a screen that shows the **date** under the total. iPhone: **Health → Steps → D** (or Fitness → Step Count). A card that shows only a time (like "21:54") can\'t be dated, so an admin has to check it.' },
      'If your challenge has **"Don\'t require a date"** switched on (Settings → Evidence), a screen that only says **"Today"** is fine - it counts for the day you upload it. A screenshot that shows a **different** date still goes to an admin, and so does one with **exactly the same steps** as one of your last 10 screenshots (it looks like the same screenshot again).',
      { example: ['"TOTAL 9,120 · 22 Nov 2026" uploaded on 22 Nov → approved automatically (target 7,000).',
        'A screenshot dated 17 Nov uploaded on 22 Nov → sent to an admin ("date mismatch").',
        '"Daily average 6,850" (a week view) → never counted as a day; sent to an admin.'], title: 'Examples' },
      'Changed your mind? Until midnight you can upload a better one (it replaces the last) - or remove it (see **Removing a screenshot**).',
    ] },
  { id: 'several', group: 'Daily check-in', audience: ['everyone'], title: 'Several screenshots a day (if your challenge allows it)', keywords: 'multiple screenshots add up highest phone watch total in progress',
    body: [
      'If **Settings → Evidence → Allow several screenshots a day** is on, each upload is added to the day instead of replacing the last. Each one is checked on its own; your Today card lists them with the total.',
      { list: ['**Add them up** - for different devices (phone + watch).', '**Use the highest** - for one app\'s running total during the day.'] },
      'The day is **met** as soon as the approved total reaches the target; otherwise it shows **In progress** until midnight, then it is decided.',
      { example: ['Add them up: phone 1,000 + watch 6,500 = **7,500** → met.', 'Use the highest: 3,000 at noon and 7,400 at night from the same app → **7,400**, not 10,400.'], title: 'Examples' },
      { tip: 'The same picture can\'t be added twice in a day. Up to 10 screenshots a day.' },
    ] },
  { id: 'remove', group: 'Daily check-in', audience: ['everyone', 'admin'], title: 'Removing a screenshot', keywords: 'delete undo remove withdraw private photo erase wrong photo',
    body: [
      '**Until that day\'s midnight:** tap **Remove** next to your screenshot (Today card, or the day in the calendar). The day goes back to "not sent" and you can upload another.',
      '**After midnight** the day is decided, so tap **Ask to remove**, give a reason, and an admin decides in **Review → Requests to remove screenshots**. If approved, points and fines are recalculated.',
      '**Private photo by mistake?** Tick "It\'s a private photo" - an admin then erases the image permanently (the record that a screenshot existed stays).',
      { example: ['Uploaded a gallery photo at 9 pm → Remove → upload the right one before midnight.', 'Noticed the next morning → Ask to remove: "Wrong photo, it\'s my friend\'s phone" → an admin approves → that day counts as missed (unless corrected with the right evidence).'], title: 'Examples' },
    ] },
  { id: 'rest-days', group: 'Daily check-in', audience: ['everyone'], title: 'Rest days', keywords: 'rest day break holiday 10 am cancel weekly allowance',
    body: [
      'Calamari allows **1 rest day per week** and **6 in total**, declared **before 10:00** on the day (or planned ahead). A rest day costs nothing: no fine, no points, it doesn\'t break your streak and doesn\'t count against your adherence.',
      { steps: ['Today: **Today → Take today as a rest day** (before 10:00).', 'Another day: **Today → Plan a rest day** (above the calendar).', 'Cancel it before its 10:00 cut-off if you change your mind.'] },
      { tip: 'A day that already has a screenshot can\'t become a rest day.' },
    ] },
  { id: 'exemptions', group: 'Daily check-in', audience: ['everyone', 'admin'], title: 'Sick-day / emergency exemptions', keywords: 'exemption sick emergency vote illness travel excused',
    body: [
      'For illness or an emergency: **Exemptions → Request**, choose the day(s), give a reason and optional evidence.',
      'Depending on the challenge, other participants **vote** or an admin decides; a tie goes to an admin. An approved exemption means: no fine, no points, the days don\'t count against adherence, your streak pauses, and it doesn\'t use a rest day.',
      { tip: 'Admins can override a decision with a reason; everything is recorded.' },
    ] },
  { id: 'appeal', group: 'Daily check-in', audience: ['everyone'], title: 'Asking an admin to look again (appeal)', keywords: 'appeal declined rejected below target look again',
    body: ['If a screenshot was declined or counted below target, open that day in the **calendar** → **Ask an admin to look again**, and say why. One appeal per decision; it returns to the admins\' Review queue.'] },

  // ---------- Points & progress ----------
  { id: 'points', group: 'Points & progress', audience: ['everyone'], title: 'Points, streaks and penalties (Calamari)', keywords: 'points streak penalty miss comeback team bonus weekend score',
    body: [
      'Points are worked out by the app from your days - nobody types them in. Calamari:',
      { list: ['**+10** for each successful day (7,000+ steps).', '**−15** for each missed day.',
        '**+20** at a 7, 14, 21, 28 and 35-day personal streak.', '**+10** comeback: 3 good days in a row after 2+ misses (up to 3 times).',
        '**+10** team streak every 8 days the whole team succeeds.', '**+10** weekend bonus activity (once per weekend).'] },
      'Rest days and approved exemptions pause streaks rather than breaking them. The **Rules** tab always shows the exact numbers for your challenge.',
      { example: ['Mon ✓ Tue ✓ Wed ✗ Thu ✓ → +10 +10 −15 +10 = **+15**, streak 1.'], title: 'Example' },
    ] },
  { id: 'leaderboard', group: 'Points & progress', audience: ['everyone'], title: 'Leaderboard and prizes', keywords: 'leaderboard race track rank prize adherence 80% top three qualify tie',
    body: [
      '**🏁 The race** at the top shows everyone as a face that moves one step per successful day (🏁 = the last day; the dashed line is where someone hitting every day would be now). Hover or tap a face for details.',
      'Ranking: points, then adherence, successful days, longest streak, then who got there first.**Hover over a name** to see whether they are on track for prizes; **tap a name** to open their profile (only what that person has chosen to share).',
      '**Adherence** = successful days ÷ days that counted (rest days and exemptions don\'t count). Calamari\'s prize line is **80%**.',
      { list: ['**70%** of the prize pool is shared **equally** by everyone at 80% or above.', '**30%** goes to the top three: **50% / 30% / 20%**. Someone below 80% can\'t take a top-three place - the next eligible person moves up.'] },
      { example: ['Prize pool ₹20,000: ₹14,000 shared by 10 qualifiers = ₹1,400 each; top three get ₹3,000 / ₹1,800 / ₹1,200 on top.'], title: 'Example' },
      '**Joined late?** Prizes are in proportion to the days you took part (Calamari: 40 days). Your qualifier share is weighted by your days, and a top-three prize is scaled the same way - the rest goes to the other qualifiers. Your weekly contributions were already only for the weeks you took part.',
      { example: ['Joined on day 15 → took part 26 of 40 days (65%): your qualifier share counts as 26/40 of a full share; winning 1st place (₹3,000) pays ₹1,950, and ₹1,050 goes to the qualifiers.'], title: 'Late joiner example' },
    ] },
  { id: 'coach', group: 'Points & progress', audience: ['everyone'], title: 'Your coach', keywords: 'coach weekly summary nudge aim',
    body: ['After each week you get a short summary on the Today tab (and an alert): days done, compared with last week, steps, streak, adherence vs the prize line, points, and one realistic aim. If your steps aren\'t in by the evening (Calamari: 8 pm) you get a personal nudge. Admins can switch parts off in **Settings → Coach**.'] },
  { id: 'today-tab', group: 'Points & progress', audience: ['everyone'], title: 'The Today tab', keywords: 'today card calendar my money rings collapsible',
    body: ['Tap a **calendar day** for a pop-up summary (status, steps, upload time, streak, day number). On a day you met the target, **📣 Post to the community** opens Community with a ready-made post and that day\'s screenshot - edit it or post it as it is.', 'Today\'s card (upload, status, deadline), **My money** (your share of the pot, this week\'s fine pool, the prize pool), your numbers, **Your coach**, points, the rest-day planner and the calendar. Tap a section title to fold it away - it stays folded on this phone. Tap a calendar day for its details.'] },

  // ---------- Money ----------
  { id: 'paying', group: 'Money', audience: ['everyone'], title: 'Paying your weekly contribution', keywords: 'pay upi utr qr contribution weekly due overdue',
    body: [
      'Calamari is **₹1,000 a week**: ₹400 to the prize pool and ₹600 into your own fine pool. Due on **Sunday**; after a 2-day grace it shows as overdue (it never affects points).',
      { steps: ['**Money** tab → scan the QR or use the UPI ID shown.', 'Pay in your UPI app, then tap **I\'ve paid this week** and enter the **UTR / reference** (if your challenge makes it optional, you can leave it out) and the date.', 'The finance manager confirms it; the week turns **Paid**.'] },
      { tip: 'Paid more than needed? The extra counts towards your next weeks automatically.' },
    ] },
  { id: 'fine-pool', group: 'Money', audience: ['everyone', 'finance'], title: 'Fines and the fine pool (carry-over)', keywords: 'fine pool carry forward refund top up 700 600 miss',
    body: [
      'Each missed day moves **₹100** from your fine pool to the prize pool (never more than is in your pool that week). With **Carried to next week** (Calamari), what\'s left in your fine pool stays yours and you only pay the top-up next week. After the last week, what\'s left is refunded.',
      { example: ['Week 1: no misses → ₹600 left → week 2 you pay **₹400**.', 'Week 1: 3 misses (₹300 to the prize pool) → ₹300 left → week 2 you pay ₹400 + ₹300 = **₹700**.', 'Week 1: 7 misses → pool empty → week 2 you pay the full **₹1,000**.'], title: 'Examples' },
      'The Money tab shows each week: contribution, what was carried over, fines and what\'s left.',
    ] },

  // ---------- Community & profile ----------
  { id: 'community', group: 'Community & profile', audience: ['everyone', 'admin'], title: 'Community feed', keywords: 'post comment reaction announcement report moderation mute pin achievement',
    body: [
      'Each challenge has its own feed: posts with photos, reactions, comments and replies, and announcements from admins (pinned). **Share an achievement** posts a streak or comeback straight from your points.',
      'Something wrong? **⋯ → Report**. Admins can pin, remove (with a reason - the author is told why and can delete it) or mute someone for a few days.',
    ] },
  { id: 'profile', group: 'Community & profile', audience: ['everyone'], title: 'Your profile and privacy', keywords: 'profile photo privacy visibility mobile email',
    body: ['**Profile**: photo (crop and zoom), name, mobile, email and more. Tap the chip next to each item to change who can see it: 🔒 only me → 👥 my challenge members → 🌍 everyone in the app (then Save). Tap someone\'s name to see what they share.', 'Read the full **Privacy policy** from the sign-in screen or Profile.'] },
  { id: 'appearance', group: 'Community & profile', audience: ['everyone'], title: 'Colours and background picture', keywords: 'theme colour color appearance dark light background picture photo wallpaper sunset ocean neon berry',
    body: [
      '**Profile → Appearance.** Pick a colour theme - **Sunset** (the default), Classic Mint, Ocean Pop, Neon Sport or Berry Bloom - and **Automatic** (follows your phone), **Light** or **Dark**.',
      '**Background picture:** a built-in scene (Sunrise hills, Running track, Mountain peaks, Calm waves) or **your own photo**, shown faded behind everything. Use **How visible** to make it stronger or softer.',
      { tip: 'These choices are saved on this device only. Your own photo is never uploaded - nobody else sees it.' },
    ] },
  { id: 'health', group: 'Community & profile', audience: ['everyone', 'super'], title: 'Health profile', keywords: 'health weight height bmi consent share private support access',
    body: [
      'Optional: **Profile → Health profile**. Nothing is stored until you give consent. Record height, weight (BMI is worked out), waist, body fat and resting heart rate as dated entries with progress charts; set goals and fitness level.',
      'Everything is **private by default**. Choose per item: only me, my challenge admins, my challenge members, or everyone. Super Admins and the finance manager see nothing unless you share it or grant **support access** (1-72 hours, every view logged).',
      'You can withdraw consent or **delete all** your health data at any time.',
    ] },

  // ---------- For admins ----------
  { id: 'admin-view', group: 'For admins', audience: ['admin'], title: 'Admin view switch', keywords: 'admin view toggle participant tabs switch',
    body: ['Next to the challenge name, **Admin view** switches between your two sets of tabs. **On** = only the admin tabs (Team, Leaderboard, Results, Review, Roster, Admins, Settings, Rules, and the admin side of Money, Exemptions and Bonus); your own Today, Demo, "My money" and requests are hidden. **Off** = you see the challenge exactly as a participant does. It is remembered per challenge on this device.'] },
  { id: 'admins-tab', group: 'For admins', audience: ['admin'], title: 'Admins and the finance manager', keywords: 'admin role two admins finance manager handover appoint',
    body: [
      '**Calamari → Admins.** A challenge needs **at least 2 admins** (so nothing depends on one person); any admin can add more. One admin\'s money requests are approved by another.',
      'There is exactly **one finance manager**. To change it, an admin starts a **handover**: the checks show the money held and anything pending; the new manager confirms the amount received and that the accounts are settled, then enters their own UPI/QR.',
    ] },
  { id: 'people-roster', group: 'For admins', audience: ['admin'], title: 'Accounts, roster and invitations', keywords: 'people account create invite roster participant join mobile',
    body: [
      '**People** (bottom bar): create accounts with a username and the person\'s **mobile number** (needed for WhatsApp reminders). Share the temporary password shown once.',
      '**Calamari → Roster → Invite** adds people to the challenge; they accept the rules in the app to join.',
    ] },
  { id: 'review', group: 'For admins', audience: ['admin'], title: 'Reviewing screenshots (Approve / Decline)', keywords: 'review approve decline flags date mismatch below target queue',
    body: [
      '**Calamari → Review** lists screenshots the app couldn\'t approve on its own, with what it read and why (flags). Check the photo, correct the number if needed, then **Approve** or **Decline** (a reason is required). The app decides met or missed from the approved number.',
      { list: ['**Date mismatch** - the screenshot shows another day.', '**Date not visible** - e.g. only a time like "21:54".', '**Weekly or average** - a week view or a daily average, not one day\'s total.', '**Duplicate image** - the same picture was used before.', '**Low confidence / unreadable** - hard to read.'] },
      'You can\'t review your own screenshots. **Requests to remove screenshots** also appear here (approve, optionally erasing a private photo, or decline with a note).',
      { tip: 'Tap a screenshot to open it full-screen; ✕ or Back closes it. Each card folds away.' },
    ] },
  { id: 'correct', group: 'For admins', audience: ['admin'], title: 'Correct (record evidence or a rest day for someone)', keywords: 'correct correction whatsapp record evidence rest day note steps approve admin',
    body: [
      'For a screenshot or a rest day that reached you another way (e.g. **WhatsApp**). **Calamari → Team → Correct** next to the person (never on your own row - another admin corrects your days).',
      { steps: ['**Record evidence:** pick the challenge day, attach the screenshot and type the **steps** it shows → **Save and approve**. A note is optional.',
        '**Record rest day:** pick the day. A note is optional. Weekly and total limits still apply.'] },
      'With the steps entered, it is **approved at once** - no Review task; the app decides target met or missed from the number. Leave the steps empty and it is checked like any upload (read automatically, or it lands in Review). Points, streaks, fines and the race track update within a minute. Everything is in the activity log under your name.',
      { example: ['Priya sent her screenshot on the WhatsApp group on **23 Nov** because the app wouldn\'t load → Correct → Record evidence → day 23 Nov → attach it → steps 8214 → Save and approve.',
        'Ravi messaged "rest day today" on 24 Nov → Correct → Record rest day → 24 Nov → Save.'], title: 'Examples' },
      { tip: 'Only record it for the day it was actually sent - by saving, you are confirming it arrived on that day in time.' },
    ] },
  { id: 'team-calendar', group: 'For admins', audience: ['admin'], title: 'Team calendar and PDF reports', keywords: 'calendar admin team days grid participant filter dates pdf report download print',
    body: [
      '**Calamari → Team → 📅 Calendar** (folds away). Choose **Everyone** or one person, and the dates (**From / To**, or **Last 7 days** / **Whole challenge**).',
      { list: ['**Everyone:** one row per person and a coloured square per day - green met, red missed, blue waiting, striped rest. The number is the steps that counted (📱 = from Apple Health); the last column is adherence %.',
        '**One person:** their month calendar, with the steps on each day and a **Download PDF** button.',
        '**Tap a day** for its details: status, steps, where they came from, the admin note and the screenshot. Change a day with **Correct** in the Team table.'] },
      '**📄 PDF** next to each person in the Team table downloads their report: summary (days met/missed, adherence, streaks, points by kind), money week by week, and every day of the challenge. On iPhone it opens the Share sheet - **Save to Files**, WhatsApp or Mail. Participants can be sent their own report; each download is in the activity log.',
    ] },
  { id: 'team-tab', group: 'For admins', audience: ['admin'], title: 'Team tab: race track, who needs a hand, WhatsApp reminders', keywords: 'team race track whatsapp reminder at risk nudge group message',
    body: [
      '**🏁 The race:** each face moves one step per successful day; 🏁 is the last day; the dashed line is where someone hitting every day would be now. Hover or tap a face for days, streak, points, adherence and today\'s status.',
      '**🤝 Who might need a hand:** people with 2+ misses in a row or below the prize line, with a **Check in** button (a friendly WhatsApp message).',
      '**WhatsApp reminders:** who hasn\'t sent today\'s steps, with **📲 Remind** (opens WhatsApp to that person with an editable message) or **Message the group**. Messages go from your own WhatsApp; the row then shows "Reminded … by …" so admins don\'t repeat each other.',
    ] },
  { id: 'bonus', group: 'For admins', audience: ['admin', 'everyone'], title: 'Weekend bonus activities', keywords: 'bonus weekend activity extra points',
    body: ['Admins set up an activity for a weekend in the **Bonus** tab (title, what to send). Participants submit a photo that weekend; an admin approves it for the bonus points (Calamari: +10, once per weekend).'] },
  { id: 'settings', group: 'For admins', audience: ['admin', 'super'], title: 'Settings (rules) and how changes apply', keywords: 'settings rules version change evidence verification rest days scoring coach community money prizes',
    body: [
      '**Calamari → Settings** holds every rule: basics, activity and target, **evidence** (instructions; several screenshots a day), verification, rest days, exemptions, scoring, **coach**, community, money and prizes.',
      'Once a challenge has started, saving creates a **new rules version** from a date you choose - **today** at the earliest (then it applies to the whole of today straight away); days already over keep their rules. A reason is required. After **Save settings** you see "✅ Settings saved" and the save box closes.',
      { list: ['**Weeks start on** is locked once the challenge starts (it would reshuffle weeks, money and rest days).', '**Money** and **Prizes** can only be changed by a Super Admin.', 'Heads-ups about unfinished settings appear in Alerts.'] },
      { example: ['Turning on "Allow several screenshots a day → Add them up" before the start applies from day 1; turning it on mid-challenge applies from the date you pick.'], title: 'Example' },
    ] },

  // ---------- For the finance manager ----------
  { id: 'payments-admin', group: 'For the finance manager', audience: ['finance', 'admin'], title: 'Confirming payments, two-person rule and refunds', keywords: 'confirm payment utr finance two person refund record on behalf cash',
    body: [
      '**Money** tab (finance view): payments reported with their UTR wait for you to **Confirm** or **Reject** (with a reason) after checking your bank / UPI app.',
      '**Settings → Money → UTR mandatory** (Super Admin) decides whether participants must give a UTR when they report a payment. **Record payment** (a participant\'s row): for someone else it counts **straight away** - e.g. cash handed over, or a UTR sent on WhatsApp; UTR and "where it was reported" are optional. Your **own** payment (if you also take part) waits for **another** admin to confirm it. Refunds are proposed by one person and approved by a **different** admin.',
      'The **checks** at the bottom must all be green - they prove the books balance.',
      { tip: 'Payment details (UPI ID, QR) are set by the finance manager in the Money tab.' },
    ] },
  { id: 'results', group: 'For the finance manager', audience: ['finance', 'admin', 'super'], title: 'Results, prizes and payouts', keywords: 'results settlement payout prize tie publish approve',
    body: ['After the last day, **Results** shows what is still blocking (reviews, payments), then the recommended prize split. Ties are never decided silently - a choice is made and recorded (splitting equally is recommended). The finance manager prepares it; a **Super Admin approves and publishes** the results; payouts are then recorded, with anything a person still owes set off automatically.'] },

  // ---------- For Super Admins ----------
  { id: 'activity-log', group: 'For Super Admins', audience: ['super'], title: 'Activity log and errors', keywords: 'activity log audit who did what errors csv sign in',
    body: ['**People → 📜 Activity log**: every action - who, what, when, which challenge, reason, before → after, device and IP - including sign-ins and failed sign-ins. Filter by person, challenge, action, dates or search; **Download CSV**. **Errors** shows anything that broke on the server. Entries can\'t be edited or deleted.'] },
  { id: 'backups', group: 'For Super Admins', audience: ['super'], title: 'Backups', keywords: 'backup restore offsite google drive encrypted',
    body: ['Every night at 03:15 the database and photos are backed up on the server and an **encrypted** copy goes to Google Drive (30 daily, 12 weekly, 12 monthly). Every Sunday a restore test proves a backup can be opened. Keep the two encryption passwords in your password manager - without them the Drive copies can\'t be opened.'] },
];

/** All the words of a topic, for search. */
export const topicText = (t: Topic): string => [t.title, t.keywords ?? '', t.group, ...t.body.flatMap((b) =>
  typeof b === 'string' ? [b] : 'list' in b ? b.list : 'steps' in b ? [b.title ?? '', ...b.steps] : 'example' in b ? [b.title ?? '', ...b.example] : [b.tip])].join(' ').replace(/\*\*/g, '');
