const express = require('express');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const session = require('express-session');
const mariadb = require('mariadb');
const cookieParser = require("cookie-parser")
const sgMail = require('@sendgrid/mail')
require('dotenv').config();
const sanitizeHtml = require('sanitize-html');
const expressSitemapXml = require('express-sitemap-xml')

const fs = require('fs');
const mammoth = require('mammoth');

const app = express();
const port = 3000;

// Ensure the 'uploads' directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

app.use(expressSitemapXml(getUrls, process.env.URL));

async function getUrls() {
  const urlsFromDatabase = await getUrlsFromDatabase();
  return ['/', ...urlsFromDatabase]; // Add the main page to the sitemap
}

async function getUrlsFromDatabase() {
  let conn;
  try {
    conn = await pool.getConnection();
    const files = await conn.query("SELECT filename FROM files");
    const urls = files.map(file => `/view/${file.filename}`);
    return urls;
  } catch (err) {
    console.error('Error fetching URLs from database:', err);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    req.isAuthenticated = true;
    return next();
  }
  req.isAuthenticated = false;
  res.redirect('/login');
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


app.use(session({
  secret: process.env.SECERT_KEY,
  resave: false,
  saveUninitialized: false,
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

// Initialize MariaDB connection pool
const pool = mariadb.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: process.env.PROCESS_USER,
  password: process.env.PROCESS_PASSWORD,
  database: process.env.PROCESS_DATABASE,
  connectionLimit: 5
});

// Ensure the database tables exist
async function initializeDatabase() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(255), password VARCHAR(255), email VARCHAR(255), isAdmin TINYINT DEFAULT 0)");
    await conn.query("CREATE TABLE IF NOT EXISTS files (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, filename VARCHAR(255), description TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    if (conn) conn.release();
  }
}
initializeDatabase();


// Route to render the signup page
app.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign Up' });
});

// Route for user signup
app.post('/signup', async (req, res) => {
  // Sanitize input
  const username = sanitizeHtml(req.body.username);
  const password = sanitizeHtml(req.body.password);
  const email = sanitizeHtml(req.body.email);

  // Validate username
  const usernameRegex = /^[A-Za-z0-9_]{1,12}$/;
  if (!usernameRegex.test(username)) {
    return res.render('signup', { title: 'Sign Up', error: 'Username must be alphanumeric and no more than 12 characters long' });
  }

  // Validate password
  const passwordRegex = /^(?=.*[A-Z])(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,}$/;  if (!passwordRegex.test(password)) {
    return res.render('signup', { title: 'Sign Up', error: 'Password must be at least 8 characters long, contain at least one uppercase letter, and one special character' });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    // Check if the user already exists
    const user = await conn.query("SELECT * FROM users WHERE username = ?", [username]);
    if (user.length > 0) {
      return res.render('signup', { title: 'Sign Up', error: 'User already exists' });
    }

    // If user does not exist, proceed with signup
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await conn.query("INSERT INTO users (username, password, email) VALUES (?, ?, ?)", [username, hashedPassword, email]);
    req.session.userId = result.insertId.toString(); // Convert BigInt to string

    // Send welcome email
    sendWelcomeEmail(email); // Comment this line out for testing

    res.render('signup', { title: 'Sign Up', success: 'Signup successful! Please check your email for a welcome message.' });
  } catch (err) {
    // Log the error with a unique identifier for debugging purposes
    const errorId = Date.now(); // You can use a more sophisticated method to generate unique IDs
    console.error(`Error during signup [${errorId}]:`, err);

    // Render the signup page with a generic error message and the unique error ID
    res.render('signup', { 
        title: 'Sign Up', 
        error: `An error occurred while creating your account. Please try again later. (Error ID: ${errorId})` 
    });
  } finally {
    if (conn) {
        try {
            conn.release();
        } catch (releaseErr) {
            console.error('Error releasing the connection:', releaseErr);
        }
      }
  } 
});

sgMail.setApiKey(process.env.SEND_API);

function sendWelcomeEmail(to) {
  // Email validation function
  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  // Validate the email address
  if (!isValidEmail(to)) {
    console.error('Invalid email address:', to);
    return; // Exit the function if the email is invalid
  }

  const msg = {
    to,
    from: process.env.SENDER_EMAIL, // Change to your verified sender
    subject: 'Welcome to Email Me The Notes!',
    text: 'Thank you for signing up!',
    html: '<strong>Thank you for signing up! We hope you enjoy and upload a lot of notes!</strong>',
  };

  sgMail
    .send(msg)
    .then(() => {
      console.log('Welcome email sent to:', to);
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
  res.render('beta', { title: 'beta' });
});

app.post('/login', async (req, res) => {
  // Sanitize input
  const username = sanitizeHtml(req.body.username);
  const password = sanitizeHtml(req.body.password);

  console.log('Login request received:', { username });

  let conn;
  try {
    conn = await pool.getConnection();
    console.log('Database connection established');

    // Fetch the user from the database, ensuring case-insensitive matching
    const rows = await conn.query("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [username]);
    //console.log('Database query result:', rows);

    // Check if user exists
    if (!rows || rows.length === 0) {
      console.log('User not found:', username);
      return res.redirect('/login?error=Invalid credentials');
    }

    const user = rows[0]; // Access the first row of the result
    //console.log('User fetched from database:', user);

    // Ensure the user object contains the password property
    if (!user.password) {
      console.log('User password not found:', user);
      return res.redirect('/login?error=Invalid credentials');
    }

    // Validate the password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log('Password validation result:', isPasswordValid);

    if (!isPasswordValid) {
      console.log('Invalid password for user:', username);
      return res.redirect('/login?error=Invalid credentials');
    }

    // Set the user ID and user data in the session
    req.session.userId = user.id.toString(); // Convert BigInt to string if necessary
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
    }; // Store relevant user information in the session
    console.log('Session userId set:', req.session.userId);

    res.redirect('/'); // Redirect to home page after successful login
  } catch (err) {
    console.error('Error during login:', err);
    res.redirect('/login?error=An error occurred during login');
  } finally {
    if (conn) conn.release(); // Always release the connection back to the pool
  }
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
app.get('/upload', async (req, res) => {
  console.log('Session User ID:', req.session.userId); // Debugging statement

  if (!req.session.userId) {
    return res.redirect('/login');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const files = await conn.query("SELECT files.*, users.username FROM files JOIN users ON files.user_id = users.id WHERE files.user_id = ?", [req.session.userId]);
    console.log('Files Retrieved:', files); // Debugging statement

    const fileList = files.map(file => ({
      name: file.filename,
      url: `/uploads/${file.filename}`,
      type: path.extname(file.filename).substring(1),
      username: file.username
    }));

    res.render('upload', { title: 'Upload Files', files: fileList, isLoggedIn: true });
  } catch (err) {
    console.error('Database Error:', err); // Debugging statement
    res.status(500).send('Error retrieving files');
  } finally {
    if (conn) conn.release();
  }
});

// Route for file upload
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('You must be logged in to upload files');
  }

  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }

  const { name, description } = req.body;
  const sanitizedName = sanitizeHtml(name);
  const sanitizedDescription = sanitizeHtml(description);
  const originalName = req.file.originalname;
  const fileExtension = path.extname(originalName);
  let newFilename = sanitizedName ? sanitizedName + fileExtension : originalName;
  let finalPath = path.join(uploadDir, newFilename);
  let counter = 0;

  while (fs.existsSync(finalPath)) {
    counter++;
    newFilename = sanitizedName ? `${sanitizedName}(${counter})${fileExtension}` : `${path.parse(originalName).name}(${counter})${fileExtension}`;
    finalPath = path.join(uploadDir, newFilename);
  }

  fs.rename(req.file.path, finalPath, async (err) => {
    if (err) {
      return res.status(500).send('Error renaming file');
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("INSERT INTO files (user_id, filename, description) VALUES (?, ?, ?)", [req.session.userId, newFilename, sanitizedDescription || '']);
      res.send('<script>alert("Upload complete!"); window.location.href="/upload";</script>');
    } catch (err) {
      console.error('Error uploading file:', err);
      res.status(500).send('Error uploading file');
    } finally {
      if (conn) conn.release();
    }
  });
});

// API route to fetch latest user uploads
app.get('/api/latest-uploads', async (_, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const files = await conn.query("SELECT files.*, users.username FROM files JOIN users ON files.user_id = users.id ORDER BY files.id DESC LIMIT 10");
    const fileList = files.map(file => ({
      name: file.filename,
      description: file.description,
      icon: '/static/icons/folder.png', // Assuming you have an icon for folders
      url: `/download/${file.filename}`,
      username: file.username
    }));
    res.json(fileList);
  } catch (err) {
    console.error('Error retrieving files:', err);
    res.status(500).json({ error: 'Error retrieving files' });
  } finally {
    if (conn) conn.release();
  }
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
app.get('/admin', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const user = await conn.query("SELECT isAdmin FROM users WHERE id = ?", [req.session.userId]);
    if (user.length === 0 || user[0].isAdmin !== 1) {
      return res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    }
    const files = await conn.query("SELECT filename FROM files");
    const fileList = files.map(file => file.filename);
    res.render('admin', { title: 'Admin Page', files: fileList, isLoggedIn: true });
  } catch (err) {
    console.error('Error retrieving admin data:', err);
    res.status(500).send('Error retrieving admin data');
  } finally {
    if (conn) conn.release();
  }
});

// Route to delete a specific file
app.delete('/delete-file/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  fs.unlink(filePath, async (err) => {
    if (err) {
      return res.status(500).send('Error deleting file');
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("DELETE FROM files WHERE filename = ?", [filename]);
      res.sendStatus(200);
    } catch (err) {
      console.error('Error deleting file from database:', err);
      res.status(500).send('Error deleting file from database');
    } finally {
      if (conn) conn.release();
    }
  });
});

// Route to delete all files
app.delete('/delete-all-files', async (req, res) => {
  fs.readdir(uploadDir, async (err, files) => {
    if (err) {
      return res.status(500).send('Error reading files');
    }

    files.forEach(file => {
      fs.unlinkSync(path.join(uploadDir, file));
    });

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("DELETE FROM files");
      res.sendStatus(200);
    } catch (err) {
      console.error('Error deleting files from database:', err);
      res.status(500).send('Error deleting files from database');
    } finally {
      if (conn) conn.release();
    }
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
    if (path.extname(filename).toLowerCase() === '.docx') {
      fs.readFile(filePath, (err, data) => {
        if (err) {
          console.error('Error reading .docx file:', err);
          return res.status(500).send('Error reading .docx file');
        }

        mammoth.convertToHtml({ buffer: data })
          .then(result => {
            console.log('HTML extraction successful:', result.value); // Debugging statement
            const htmlContent = result.value.trim() ? result.value : 'No content available';
            res.render('viewer', { title: 'View File', content: htmlContent, isLoggedIn, fileUrl: `/uploads/${filename}`, filename });
          })
          .catch(err => {
            console.error('Error extracting HTML from .docx file:', err);
            res.status(500).send('Error extracting HTML from .docx file');
          });
      });
    } else {
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          console.error('Error reading file:', err);
          return res.status(500).send('Error reading file');
        }
        res.render('viewer', { title: 'View File', content: `<pre class="content-viewer">${data}</pre>`, isLoggedIn, fileUrl: `/uploads/${filename}`, filename });
      });
    }
  });
});

app.get('/profile', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;

  let conn;
  try {
    conn = await pool.getConnection();
    console.log('Database connection established');

    // Fetch files for the logged-in user
    const [files] = await conn.query('SELECT * FROM files WHERE user_id = ?', [userId]);
    console.log('Files fetched from database:', files);

    // Ensure files is an array
    const uploads = Array.isArray(files) ? files : [files];
    console.log('Uploads array:', uploads);

    res.render('profile', {
      title: 'Your Profile',
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
      uploads: uploads, // Pass the files as uploads to the template
    });
  } catch (err) {
    console.error('Error fetching files:', err);
    res.render('profile', {
      title: 'Your Profile',
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
      uploads: [],
      error: 'An error occurred while fetching your files.',
    });
  } finally {
    if (conn) conn.release(); // Always release the connection back to the pool
  }
});

// Settings route
app.get('/settings', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user || user.length === 0) {
      throw new Error('User not found');
    }
    res.render('settings', { 
      title: 'Settings', 
      user: user[0], 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.render('settings', { 
      title: 'Settings', 
      error: 'Error fetching user', 
      user: {}, 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  }
});

// Route to update username
app.post('/update-username', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { username } = req.body;

    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, userId]);

    res.render('settings', { 
      title: 'Settings', 
      success: 'Username updated successfully', 
      user: { ...req.session.user, username }, 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  } catch (error) {
    console.error('Error updating username:', error);
    res.render('settings', { 
      title: 'Settings', 
      error: 'Error updating username', 
      user: req.session.user, 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  }
});

// Route to update email
app.post('/update-email', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { email } = req.body;

    await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, userId]);

    res.render('settings', { 
      title: 'Settings', 
      success: 'Email updated successfully', 
      user: { ...req.session.user, email }, 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  } catch (error) {
    console.error('Error updating email:', error);
    res.render('settings', { 
      title: 'Settings', 
      error: 'Error updating email', 
      user: req.session.user, 
      isLoggedIn: true, 
      darkMode: req.session.darkMode || false 
    });
  }
});

app.post('/update-password', isAuthenticated, async (req, res) => {
  // Sanitize input
  const currentPassword = sanitizeHtml(req.body.currentPassword);
  const newPassword = sanitizeHtml(req.body.password);
  const userId = req.session.userId;

  console.log('Received update password request');
  console.log('Session userId:', userId);

  if (!currentPassword || !newPassword) {
    return res.render('settings', {
      title: 'Settings',
      error: 'Both current and new passwords are required.',
      user: req.session.user,
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
    });
  }

  if (currentPassword === newPassword) {
    return res.render('settings', {
      title: 'Settings',
      error: 'New password cannot be the same as the current password.',
      user: req.session.user,
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    console.log('Database connection established');

    // Fetch the user from the database
    const rows = await conn.query('SELECT * FROM users WHERE id = ?', [userId]);
    //console.log('Database query result:', rows);

    // Check if user exists
    if (!rows || rows.length === 0) {
      console.error(`User not found for userId: ${userId}`);
      throw new Error('User not found. Please log in again.');
    }

    const user = rows[0]; // Access the first row of the result
    //console.log('User fetched from database:', user);

    // Ensure the user object contains the password property
    if (!user.password) {
      console.error('User password not found:', user);
      throw new Error('User password not found.');
    }

    // Validate the current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    console.log('Password validation result:', isPasswordValid);

    if (!isPasswordValid) {
      return res.render('settings', {
        title: 'Settings',
        error: 'Current password is incorrect.',
        user: req.session.user,
        isLoggedIn: true,
        darkMode: req.session.darkMode || false,
      });
    }

    // Hash the new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update the password in the database
    const updateResult = await conn.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedNewPassword, userId]
    );

    if (updateResult.affectedRows === 0) {
      throw new Error('Failed to update password. No rows affected.');
    }

    console.log('Password updated successfully for userId:', userId);

    // Send success response
    res.render('settings', {
      title: 'Settings',
      success: 'Password updated successfully.',
      user: req.session.user,
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
    });
  } catch (err) {
    console.error('Error updating password:', err);

    res.render('settings', {
      title: 'Settings',
      error: `Error updating password: ${err.message}`,
      user: req.session.user,
      isLoggedIn: true,
      darkMode: req.session.darkMode || false,
    });
  } finally {
    if (conn) conn.release(); // Always release the connection back to the pool
  }
});

// Delete upload route
app.post('/delete-upload/:id', isAuthenticated, async (req, res) => {
  const uploadId = req.params.id;
  await pool.query('DELETE FROM files WHERE id = ?', [uploadId]);
  res.redirect('/profile');
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
