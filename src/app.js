require('dotenv').config();
const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const callbackURL= process.env.REDIRECT_URI;
const secret = process.env.SESSION_SECRET;
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const upload = multer({ dest: 'uploads/' });
const app = express();
console.log({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'http://localhost:3000/auth/google/callback',
});

app.use('/static', express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: secret || 'mysecret',
  resave: false,
  saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
console.log({ clientID, clientSecret, callbackURL, secret });

passport.use(new GoogleStrategy({
  clientID,
  clientSecret,
  callbackURL,
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar'],
}, (accessToken, refreshToken, profile, done) => {
  profile.accessToken = accessToken;
  profile.refreshToken = refreshToken;
  return done(null, profile);
}));

function capitalizeName(name) {
  if (!name) return '';
  return name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Calendar Integration</title>
      <link rel="stylesheet" href="/static/styles.css">
      <link rel="icon" type="image/x-icon" href="/static/favicon.ico">
    </head>
    <body>
      <div class="card">
        <h1>Google Calendar Integration</h1>
        <p>Automatically import your schedules to Google Calendar</p>
        <a href="/auth/google"><button class="btn">Sign in with Google</button></a>
      </div>
    </body>
    </html>
  `);
});


app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => { res.redirect('/dashboard'); }
);

app.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Dashboard</title>
      <link rel="stylesheet" href="/static/styles.css">
      <link rel="icon" type="image/x-icon" href="/static/favicon.ico">
    </head>
    <body class="dashboard-container">
      <a href="/logout" class="logout-btn">Logout</a>
      <div class="dashboard">
        <h1>Welcome, ${req.user.displayName}</h1>
        <div class="dashboard-content">
          
          <!-- Import Schedule Card -->
          <div class="card">
            <h3>Import Schedule</h3>
            <form method="POST" action="/importing">
              <select name="schedule" required>
                <option value="">Select section</option>
                <option value="1">Section A</option>
                <option value="2">Section B</option>
                <option value="3">Section C</option>
                <option value="4">Section D</option>
                <option value="5">DBM</option>
                <option value="6">HHM</option>
              </select>
              <button type="submit">Import</button>
            </form>
          </div>

          <!-- Upload CSV Card -->
          <div class="card">
            <h3>Upload Your CSV</h3>
            <form method="POST" action="/upload-csv" enctype="multipart/form-data">
              <input type="file" name="csvfile" accept=".csv" required>
              <button type="submit">Upload & Import</button>
            </form>
          </div>
          
        </div>
      </div>
    </body>
    </html>
  `);
});

// Shows a progress screen, then submits to actual import
app.post('/importing', ensureAuthenticated, (req, res) => {
  res.send(`
    <h1>Import in progress...</h1>
    <script>
      setTimeout(function() {
        document.forms[0].submit();
      }, 1200);
    </script>
    <form method="POST" action="/import-schedule" style="display:none;">
      <input type="hidden" name="schedule" value="${req.body.schedule}" />
    </form>
  `);
});

// Utility to handle dates DD/MM/YYYY or DD-MM-YYYY to YYYY-MM-DD
function fixDate(dateStr) {
  if (!dateStr) return '';
  let [day, month, year] = dateStr.split(/[\/-]/);
  if (!year) return '';
  if (year.length === 2) year = '20' + year;
  return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
}

// Main import function for your CSV structure
async function importCsvEventsListFormat(filePath, oauth2Client) {
  const events = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const subject = row['Subject']?.trim();
        const startDate = fixDate(row['Start Date']?.trim());
        const startTime = row['Start Time']?.trim();
        const endDate = fixDate(row['End Date']?.trim());
        const endTime = row['End Time']?.trim();
        const description = row['Description']?.trim();
        if (subject && startDate && startTime && endDate && endTime) {
          const startISO = new Date(`${startDate}T${startTime}:00`).toISOString();
          const endISO = new Date(`${endDate}T${endTime}:00`).toISOString();
          events.push({
            summary: subject,
            description: description || '',
            start: { dateTime: startISO },
            end: { dateTime: endISO },
          });
        }
      })
      .on('end', async () => {
        try {
          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          for (const event of events) {
            await calendar.events.insert({ calendarId: 'primary', requestBody: event });
          }
          resolve(events.length);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', reject);
  });
}

app.post('/import-schedule', ensureAuthenticated, async (req, res) => {
  const idx = parseInt(req.body.schedule, 10);
  if (isNaN(idx) || idx < 1 || idx > 6) return res.send("Invalid schedule selection.");
  const filePath = path.join(__dirname, 'sheets', `schedule${idx}.csv`);
  if (!fs.existsSync(filePath)) return res.send("Schedule CSV file not found.");
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: req.user.accessToken,
    refresh_token: req.user.refreshToken,
  });
  try {
    const importedCount = await importCsvEventsListFormat(filePath, oauth2Client);
    res.send(`<h1>Done! ${importedCount} schedule events imported from schedule${idx}.csv</h1><a href="/dashboard">Back</a>`);
  } catch (err) {
    res.send('Error importing schedule CSV: ' + String(err));
  }
});

app.post('/upload-csv', ensureAuthenticated, upload.single('csvfile'), async (req, res) => {
  if (!req.file) return res.send('No CSV file uploaded.');

  const filePath = path.resolve(req.file.path);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: req.user.accessToken,
    refresh_token: req.user.refreshToken,
  });

  try {
    console.log('Uploading CSV:', filePath);
    const importedCount = await importCsvEventsListFormat(filePath, oauth2Client);
    fs.unlink(filePath, () => {});
    res.send(`<h1>${importedCount} events imported from uploaded CSV</h1><a href="/dashboard">Back</a>`);
  } catch (err) {
    console.error('CSV Upload Error:', err);
    res.send('Error importing uploaded CSV file: ' + String(err));
  }
});
app.get('/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});


app.listen(3000, () => {
  console.log('Server listening on http://localhost:3000');
});
