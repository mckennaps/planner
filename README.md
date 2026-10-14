# Planner

A personal calendar and task app that runs in your browser and installs on iPhone, iPad and Windows like a regular app. It reads and writes your real Google Calendar, so your classes, colors and notifications carry over. Tasks and settings sync through a hidden file in your Google Drive.

**What's in this version**

- Calendar with Day, 3-day, Week, Month and Schedule views. Overlapping events sit side by side. Drag to move, drag the bottom edge to resize, click and drag on empty space to create.
- Repeating events, edited as "this event", "this and following" or "all events", same as Google Calendar.
- Color categories. Each category is a calendar in your Google account (so your class calendars already work). Any color, plus Google's 11 per-event colors.
- Notifications on each event, sent by Google Calendar to your phone.
- Tasks with due dates and times, repeats, subtasks, priority, time estimates and notifications.
- Time blocking: drag a task from the list onto the calendar, or use "Block time on calendar" in the task.

Coming next: work timer with breaks, habit tracking, rewards, projects, journal. Completed tasks are already being logged so the rewards system can count them.

---

## Setup (about 20 minutes, once)

You'll put the files on GitHub (free hosting), then tell Google the app is allowed to use your calendar.

### 1. Put the app on GitHub Pages

1. Sign in at [github.com](https://github.com) (or create a free account).
2. Click **+** (top right) → **New repository**. Name it `planner`, keep it **Public**, click **Create repository**. Public is fine: there are no passwords in the code, and your data never touches GitHub.
3. On the new repo page, click **uploading an existing file**. Drag in everything *inside* the unzipped `planner` folder (`index.html`, `sw.js`, the `css`, `js` and `icons` folders, and so on). Click **Commit changes**.
4. Go to **Settings** → **Pages**. Under **Branch**, pick `main` and `/ (root)`, then **Save**.
5. After a minute, your app is at `https://YOUR-USERNAME.github.io/planner/`. Open it to check it loads. **Try the demo** works already.

### 2. Let the app use your Google Calendar

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the Google account your calendar is on.
2. Create a project: click the project picker at the top → **New project** → name it `Planner` → **Create**. Make sure it's selected.
3. Turn on the two APIs: search the top bar for **Google Calendar API** → **Enable**. Then search **Google Drive API** → **Enable**.
4. Search the top bar for **Google Auth Platform** and open it. Click **Get started** and fill in:
   - App name: `Planner`, support email: your email
   - Audience: **External**
   - Contact email: your email
   - Agree and click **Create**.
5. In the left menu, open **Audience**. Under **Test users**, click **Add users**, enter your Gmail address and save.
6. In the left menu, open **Clients** → **Create client**:
   - Application type: **Web application**
   - Name: `Planner`
   - **Authorized JavaScript origins** → Add URI: `https://YOUR-USERNAME.github.io`
   - **Authorized redirect URIs** → Add URI: `https://YOUR-USERNAME.github.io/planner/` (with the slash at the end)
   - Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You don't need the client secret.

### 3. Add the client ID to the app

1. Back on GitHub, open `js/config.js` and click the pencil icon to edit.
2. Paste the client ID between the quotes: `googleClientId: '1234...apps.googleusercontent.com',`
3. Click **Commit changes**. Wait a minute, then reload your app page.

### 4. Sign in

Click **Sign in with Google**. Google will say it **hasn't verified this app**. That's expected for an app only you use: click **Continue**, then allow access to your calendar and to the app's own Drive file.

### 5. Install it on your devices

- **iPhone / iPad:** open your app's address in **Safari** → tap **Share** → **Add to Home Screen**. Open it from the home screen and sign in once there (home-screen apps keep their own sign-in).
- **Windows:** open it in Chrome or Edge → click the install icon at the right end of the address bar (or **⋯** → **Apps** → **Install**).

### 6. Phone notifications

Notifications are sent by Google Calendar, so they arrive even when this app is closed.

1. Install the **Google Calendar** app on your iPhone and iPad, sign in with the same account, and allow notifications.
2. In the Google Calendar app's menu, make sure your categories are ticked. When you first give a task a notification, the app creates a calendar called **Task reminders**; make sure that one is ticked too.

---

## Good to know

- **Where your data lives:** events are in Google Calendar. Tasks and settings are in a hidden app file in your Google Drive that only this app can read. A copy is kept on each device so the app opens instantly and works offline.
- **Sign-in refresh:** Google's sign-in lasts an hour. When it runs out, the app quietly bounces through Google and back (a quick flash). If Google ever asks you to sign in again, that's normal.
- **If Google asks you to approve the app every week:** in Google Auth Platform → **Audience**, click **Publish app**. It stays unverified (you'll still see the warning screen), which is fine for personal use.
- **Colors:** each category's color is that calendar's color in Google, so changes show up in Google Calendar too. Single events can also use one of Google's 11 event colors.
- **Updating the app:** when you get new versions of the files, upload them to the same repo (GitHub replaces files with the same name). The app picks up the new version the next time it opens.
