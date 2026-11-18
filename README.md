# NutriTrack 4.1

A private nutrition tracker for iPhone, built as a Progressive Web App (PWA). It also opens in Edge or Chrome on Windows.

## How it works

| Piece | What it uses | Cost / limits |
|---|---|---|
| Hosting | GitHub Pages (static files over HTTPS) | Free. The repository must be **public** on a free account. Only the app's code goes there, never your data. Limits: 1 GB site size and about 100 GB/month of traffic, far more than this app needs. |
| Your data | IndexedDB, stored on each device | Free. It never leaves the device unless you make a backup. |
| Food database | Open Food Facts API | Free, no key needed. About 100 product lookups a minute and about 10 name searches a minute. |
| Barcode reading | ZXing (open source), loaded from unpkg.com and then cached for offline use | Free. iPhone Safari has no built-in barcode API, so this library does the reading. |
| Backups | AES-256 encrypted file → share sheet → OneDrive / iCloud Drive | Free |

Total recurring cost: **$0**. You don't need an Apple Developer account, a paid API, or a Windows PC to set this up.

**Privacy:** You don't need an account or a login because there is no server holding your data. Your phone's Face ID / passcode protects it. Strict security rules (a Content-Security-Policy) block any third-party scripts or trackers. The only things sent out are barcode numbers and search words, which go to Open Food Facts.

**Windows:** Open the same web address in Edge. Each device keeps its own copy of your data. To move data between devices, make a backup on one, save it to OneDrive, and restore it on the other. Automatic sync between devices would need a private backend, which is a later option (for example Cloudflare D1 + Cloudflare Access, both on free tiers).

## Set it up from your iPhone (about 15 minutes)

1. **Unzip:** In the Files app, tap `nutritrack.zip`. A `nutritrack` folder appears.
2. **GitHub account:** Go to github.com in Safari and sign up (free).
3. **Switch to the desktop site:** Tap **aA** in the address bar → **Request Desktop Website**. GitHub's mobile layout hides the upload button.
4. **Create a repository:** Tap **+** → **New repository**. Name it `nutritrack`, choose **Public**, and tap **Create repository**.
5. **Upload the files:** Tap **uploading an existing file** → **choose your files**. Go to the `nutritrack` folder, tap **Select**, and select all 8 files: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, the three `.png` icons, and `README.md`. Then tap **Commit changes**.
6. **Turn on Pages:** Go to **Settings** → **Pages**. Under **Source**, choose **Deploy from a branch**, pick branch `main` and folder `/ (root)`, and tap **Save**. After 1–2 minutes your app is live at `https://YOUR-USERNAME.github.io/nutritrack/`.
7. **Install:** Open that address in Safari → **Share** → **Add to Home Screen**. From now on, always open NutriTrack from the Home Screen icon. Home Screen apps keep their storage more reliably than ordinary Safari tabs.
8. **Test:** Tap **Scan**, allow the camera, and scan anything in your pantry.

**To update later:** upload the changed files to the same repository. The app picks up the new version the next time it opens with internet.

## Status

**Working now:** live barcode scanning; reading a barcode from a photo or typing it in; Open Food Facts lookup; serving sizes and quantities in servings or grams; the daily diary; saved, favorite, recent, and frequent foods; custom foods and correcting records; copying the previous day or repeating a meal; goals for calories, macros, fiber, and water; a 7-day calorie chart; offline use; pending scans saved while offline; encrypted backup and restore; CSV export; deleting all data.

**Added in Phase 2:** nutrition-label photos read on your phone by Tesseract.js (free; about 15 MB downloads once), always followed by a review screen; recipes with nutrition per serving and per gram; meal photos combined with your saved foods or quick estimates, which are marked “estimate”.

**Added in Phase 3:** a weight log with 7-day average, trend, total and percent lost, BMI, and goal; body measurements; a medication journal for doses, side effects, and appetite; Apple Health import from export.zip, read on the phone; a 14-day comparison of food, activity, and weight; and a shareable progress report. Plateaus are judged from multi-week averages, never from a single weigh-in.

**Added in 4.0:** a redesigned look with a week strip, rings, and meal colors; trend weight; an estimate of calories burned (energy balance); limits for sodium, saturated fat, and added sugar; daily and weekly recaps with tips drawn from your own foods; and “Ask Claude” sharing. Updates now load the next time you open the app.

**Added in 4.1:** type-a-food search across your saved foods, USDA common and restaurant foods, and Open Food Facts brands; quick calories with “save to my foods”. USDA search works out of the box with a shared demo key; a free personal key (api.data.gov/signup) removes the limit.

**Planned (optional, later)**: automatic sync between iPhone and Windows through a private free-tier server; AI meal-photo recognition (paid, only with your approval).

**Earlier plan**

## Known limitations
- Web apps cannot read Apple Health (HealthKit) directly. Phase 3 will import the Health app's export file, and can use an iPhone Shortcut to send daily numbers. Fully automatic sync would need a native app, which requires a Mac (or a cloud Mac) and the $99/yr Apple Developer Program.
- Meal-photo calorie estimates that are actually reliable need a paid vision AI, at a cost of pennies per photo. That will only be added with your approval. The free alternative is to take a photo and then pick the foods and portions yourself.
- iOS may ask for camera permission again after the app has been closed for a while.
- The scanner library downloads the first time you open the app online. After that it is cached.
