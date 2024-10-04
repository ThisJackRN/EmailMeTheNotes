const express = require('express');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const cookieParser = require("cookie-parser")
const sgMail = require('@sendgrid/mail')
require('dotenv').config();

const fs = require('fs');
const mammoth = require('mammoth');

const app = express();
const port = 3000;

// Ensure the 'uploads' directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Set the view engine to ejs
app.set('view engine', 'ejs');

// Set the directory for EJS templates
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use('/static', express.static(path.join(__dirname, 'static')));

// Serve files from the 'uploads' directory
app.use('/uploads', express.static(uploadDir));

// Use cookie-parser middleware
app.use(cookieParser());

// Configure session middleware
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
}));

// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));

// Define a route to render an EJS page
app.get('/', (req, res) => {
  const isAuthenticated = req.session.userId ? true : false;
  const successMessage = req.session.successMessage || null;
  req.session.successMessage = null; // Clear the message after displaying it
  res.render('index', { title: 'Home', isLoggedIn: isAuthenticated, successMessage });
});


// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    cb(null, 'uploads/');
  },
  filename: (_, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Initialize SQLite database
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  if (!fs.existsSync(dbPath)) {
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, email TEXT, isAdmin INTEGER DEFAULT 0)");
    db.run("CREATE TABLE files (id INTEGER PRIMARY KEY, user_id INTEGER, filename TEXT, description TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
  }
});

// Route to render the signup page
app.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign Up' });
});

// Route for user signup
app.post('/signup', async (req, res) => {
  const { username, password, email } = req.body;

  // Validate password
  const passwordRegex = /^(?=.*[A-Z])(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.render('signup', { title: 'Sign Up', error: 'Password must be at least 8 characters long, contain at least one uppercase letter, and one special character' });
  }

  // Check if the user already exists
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) {
      return res.render('signup', { title: 'Sign Up', error: 'Error checking user existence' });
    }
    if (user) {
      return res.render('signup', { title: 'Sign Up', error: 'User already exists' });
    }

    // If user does not exist, proceed with signup
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password, email) VALUES (?, ?, ?)", [username, hashedPassword, email], function(innerErr) {
      if (innerErr) {
        return res.render('signup', { title: 'Sign Up', error: 'Error creating user' });
      }
      req.session.userId = this.lastID;

      // Send welcome email
      sendWelcomeEmail(email); // Comment this line out for testing

      res.render('signup', { title: 'Sign Up', success: 'Signup successful! Please check your email for a welcome message. Redirecting and logging in', redirect: true });
    });
  });
});


sgMail.setApiKey(process.env.SEND_API);

function sendWelcomeEmail(to) {
  const msg = {
    to,
    from: process.env.SENDER_EMAIL, // Change to your verified sender
    subject: 'Welcome to Our Service',
    text: 'Thank you for signing up!',
    html: '<strong>Thank you for signing up!</strong>',
  };

  sgMail
    .send(msg)
    .then(() => {
      console.log('Welcome email sent');
    })
    .catch((error) => {
      console.error('Error sending welcome email:', error);
    });
}


// Route to render the login page
app.get('/login', (req, res) => {
  const error = req.query.error || null;
  res.render('login', { title: 'Login', error });
});

app.get('/beta', (req, res) => {
  res.render('beta', { title: 'beta'});
});

// Route for user login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user || !(await bcrypt.compare(password, user.password))) {
      return res.redirect('/login?error=Invalid credentials');
    }
    req.session.userId = user.id;
    res.redirect('/');
  });
});

// Route for user logout
app.get('/logout', (req, res) => {
  console.log('Logout route accessed');
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ error: 'Error logging out' });
    }
    res.clearCookie('connect.sid'); // Clear the session cookie
    console.log('Session destroyed and cookie cleared');
    res.redirect('/');
  });
});

// Route to render the upload page
app.get('/upload', (req, res) => {
  console.log('Session User ID:', req.session.userId); // Debugging statement

  if (!req.session.userId) {
    return res.redirect('/login');
  }

  db.all("SELECT files.*, users.username FROM files JOIN users ON files.user_id = users.id WHERE files.user_id = ?", [req.session.userId], (err, files) => {
    if (err) {
      console.error('Database Error:', err); // Debugging statement
      return res.status(500).send('Error retrieving files');
    }

    console.log('Files Retrieved:', files); // Debugging statement

    const fileList = files.map(file => ({
      name: file.filename,
      url: `/uploads/${file.filename}`,
      type: path.extname(file.filename).substring(1),
      username: file.username
    }));

    res.render('upload', { title: 'Upload Files', files: fileList, isLoggedIn: true });
  });
});

// Route for file upload
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('You must be logged in to upload files');
  }

  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }

  const { name, description } = req.body;
  const originalName = req.file.originalname;
  const fileExtension = path.extname(originalName);
  let newFilename = name ? name + fileExtension : originalName;
  let finalPath = path.join(uploadDir, newFilename);
  let counter = 0;

  while (fs.existsSync(finalPath)) {
    counter++;
    newFilename = name ? `${name}(${counter})${fileExtension}` : `${path.parse(originalName).name}(${counter})${fileExtension}`;
    finalPath = path.join(uploadDir, newFilename);
  }

  fs.rename(req.file.path, finalPath, (err) => {
    if (err) {
      return res.status(500).send('Error renaming file');
    }

    db.run("INSERT INTO files (user_id, filename, description) VALUES (?, ?, ?)", [req.session.userId, newFilename, description || ''], (err) => {
      if (err) {
        return res.status(500).send('Error uploading file');
      }
      res.send('<script>alert("Upload complete!"); window.location.href="/upload";</script>');
    });
  });
});

// API route to fetch latest user uploads
app.get('/api/latest-uploads', (_, res) => {
  db.all("SELECT files.*, users.username FROM files JOIN users ON files.user_id = users.id ORDER BY files.id DESC LIMIT 10", (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Error retrieving files' });
    }
    const fileList = files.map(file => ({
      name: file.filename,
      description: file.description,
      icon: '/static/icons/folder.png', // Assuming you have an icon for folders
      url: `/download/${file.filename}`,
      username: file.username
    }));
    res.json(fileList);
  });
});

// Route to download files
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  res.download(filePath, (err) => {
    if (err) {
      return res.status(500).send('Error downloading file');
    }
  });
});

// Route to render the admin page
app.get('/admin', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  db.get("SELECT isAdmin FROM users WHERE id = ?", [req.session.userId], (err, user) => {
    if (err || !user || user.isAdmin !== 1) {
      return res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    }
    db.all("SELECT filename FROM files", (err, files) => {
      if (err) {
        return res.status(500).send('Error retrieving files');
      }
      const fileList = files.map(file => file.filename);
      res.render('admin', { title: 'Admin Page', files: fileList, isLoggedIn: true });
    });
  });
});

// Ensure the 'isAdmin' column exists in the 'users' table
db.serialize(() => {
  db.run("ALTER TABLE users ADD COLUMN isAdmin INTEGER DEFAULT 0", (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding isAdmin column:', err);
    }
  });
});

// Route to delete a specific file
app.delete('/delete-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  fs.unlink(filePath, (err) => {
    if (err) {
      return res.status(500).send('Error deleting file');
    }

    db.run("DELETE FROM files WHERE filename = ?", [filename], (err) => {
      if (err) {
        return res.status(500).send('Error deleting file from database');
      }
      res.sendStatus(200);
    });
  });
});

// Route to delete all files
app.delete('/delete-all-files', (req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) {
      return res.status(500).send('Error reading files');
    }

    files.forEach(file => {
      fs.unlinkSync(path.join(uploadDir, file));
    });

    db.run("DELETE FROM files", (err) => {
      if (err) {
        return res.status(500).send('Error deleting files from database');
      }
      res.sendStatus(200);
    });
  });
});


app.get('/view/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);
  const isLoggedIn = req.session.userId ? true : false; // Check if the user is authenticated

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found');
    }

    // Check if the file is a .docx file
    if (path.extname(filename) === '.docx') {
      fs.readFile(filePath, (err, data) => {
        if (err) {
          console.error('Error reading .docx file:', err);
          return res.status(500).send('Error reading .docx file');
        }

        mammoth.extractRawText({ buffer: data })
          .then(result => {
            console.log('Raw text extraction successful:', result.value); // Debugging statement
            const rawText = result.value.trim() ? result.value : 'No content available';
            res.render('viewer', { title: 'View File', content: `<pre>${rawText}</pre>`, isLoggedIn, fileUrl: `/uploads/${filename}`, filename });
          })
          .catch(err => {
            console.error('Error extracting raw text from .docx file:', err);
            res.status(500).send('Error extracting raw text from .docx file');
          });
      });
    } else {
      const fileUrl = `/uploads/${filename}`;
      res.render('viewer', { title: 'View File', content: `<iframe src="${fileUrl}" width="100%" height="600px"></iframe>`, isLoggedIn, fileUrl, filename });
    }
  });
});

// Route to toggle dark mode
app.post('/toggle-dark-mode', (req, res) => {
  const isDarkMode = req.body.isDarkMode === 'true'; // Capture the toggle state
  res.cookie('darkMode', isDarkMode, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false }); // Set cookie for one year
  res.sendStatus(200);
});

// Middleware to check dark mode cookie
app.use((req, res, next) => {
  const darkMode = req.cookies.darkMode === 'true'; // Check if darkMode cookie exists and is set to true
  res.locals.isDarkMode = darkMode; // Pass it to the views
  next();
});

