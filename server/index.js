const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

// Load environment variables from server directory
dotenv.config();

const app = express();
const port = process.env.PORT || 5001;

const allowedOrigins = [
  'http://localhost:3000',
  'https://red-connect-nine.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL database:', err);
  } else {
    console.log('Connected to PostgreSQL database successfully');
    release();
  }
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Routes

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'RedConnect Backend API', 
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString() 
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ message: 'RedConnect API is running', timestamp: new Date().toISOString() });
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if it's the admin user
    if (email === process.env.ADMIN_EMAIL) {
      const isValidPassword = password === process.env.ADMIN_PASSWORD;
      
      if (isValidPassword) {
        const token = jwt.sign(
          { email, role: 'admin' },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        res.json({
          message: 'Login successful',
          token,
          user: { email, role: 'admin' }
        });
      } else {
        res.status(401).json({ message: 'Invalid credentials' });
      }
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Submit blood donor registration
app.post('/api/donors', async (req, res) => {
  try {
    const { fullname, mobileno, emailid, age, gender, bloodGroup, address, user_agent } = req.body;
    
    // Get the client's IP address
    let clientIP = req.headers['x-forwarded-for'] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    // Handle comma-separated IP addresses (from proxies like Cloudflare)
    if (clientIP && clientIP.includes(',')) {
      clientIP = clientIP.split(',')[0].trim();
    }
    
    // Remove IPv6 prefix if present
    if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.substring(7);
    }
    
    const query = `
      INSERT INTO donors (fullname, mobileno, emailid, age, gender, blood_group_id, address, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *
    `;
    
    const values = [fullname, mobileno, emailid, age, gender, bloodGroup, address, clientIP, user_agent];
    const result = await pool.query(query, values);
    
    res.status(201).json({
      message: 'Donor registered successfully',
      donor: result.rows[0]
    });
  } catch (error) {
    console.error('Error registering donor:', error);
    res.status(500).json({ message: 'Error registering donor' });
  }
});

// Get all donors (admin only)
app.get('/api/admin/donors', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT d.*, bg.blood_group 
      FROM donors d 
      LEFT JOIN blood_groups bg ON d.blood_group_id = bg.id 
      ORDER BY d.created_at DESC
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching donors:', error);
    res.status(500).json({ message: 'Error fetching donors' });
  }
});

// Search donors
app.get('/api/donors/search', async (req, res) => {
  try {
    const { bloodGroup, location } = req.query;
    
    let query = `
      SELECT d.*, bg.blood_group 
      FROM donors d 
      LEFT JOIN blood_groups bg ON d.blood_group_id = bg.id 
      WHERE 1=1
    `;
    const values = [];
    let paramCount = 0;

    if (bloodGroup) {
      paramCount++;
      query += ` AND d.blood_group_id = $${paramCount}`;
      values.push(bloodGroup);
    }

    if (location) {
      paramCount++;
      query += ` AND LOWER(d.address) LIKE LOWER($${paramCount})`;
      values.push(`%${location}%`);
    }

    query += ` ORDER BY d.created_at DESC`;
    
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error('Error searching donors:', error);
    res.status(500).json({ message: 'Error searching donors' });
  }
});

// Submit blood request
app.post('/api/blood-requests', async (req, res) => {
  try {
    const {
      patientName,
      bloodGroup,
      unitsRequired,
      hospitalName,
      hospitalAddress,
      contactPerson,
      phoneNumber,
      urgencyLevel,
      additionalInfo,
      user_agent
    } = req.body;
    
    // Get the client's IP address
    let clientIP = req.headers['x-forwarded-for'] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    // Handle comma-separated IP addresses (from proxies like Cloudflare)
    if (clientIP && clientIP.includes(',')) {
      clientIP = clientIP.split(',')[0].trim();
    }
    
    // Remove IPv6 prefix if present
    if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.substring(7);
    }
    
    const query = `
      INSERT INTO blood_requests (
        patient_name, blood_group, units_required, hospital_name, 
        hospital_address, contact_person, phone_number, urgency_level, 
        additional_info, ip_address, user_agent, status, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW())
      RETURNING *
    `;
    
    const values = [
      patientName, bloodGroup, unitsRequired, hospitalName,
      hospitalAddress, contactPerson, phoneNumber, urgencyLevel,
      additionalInfo, clientIP, user_agent
    ];
    
    const result = await pool.query(query, values);
    
    res.status(201).json({
      message: 'Blood request submitted successfully',
      request: result.rows[0]
    });
  } catch (error) {
    console.error('Error submitting blood request:', error);
    res.status(500).json({ message: 'Error submitting blood request' });
  }
});

// Get all blood requests (admin only)
app.get('/api/admin/blood-requests', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT * FROM blood_requests 
      ORDER BY 
        CASE urgency_level 
          WHEN 'immediate' THEN 1 
          WHEN 'urgent' THEN 2 
          WHEN 'normal' THEN 3 
        END,
        created_at DESC
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching blood requests:', error);
    res.status(500).json({ message: 'Error fetching blood requests' });
  }
});

// Update blood request status (admin only)
app.put('/api/admin/blood-requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const query = `
      UPDATE blood_requests 
      SET status = $1, updated_at = NOW() 
      WHERE id = $2 
      RETURNING *
    `;
    
    const result = await pool.query(query, [status, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Blood request not found' });
    }
    
    res.json({
      message: 'Blood request status updated successfully',
      request: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating blood request:', error);
    res.status(500).json({ message: 'Error updating blood request' });
  }
});

// Get blood groups
app.get('/api/blood-groups', async (req, res) => {
  try {
    const query = 'SELECT * FROM blood_groups ORDER BY id';
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching blood groups:', error);
    res.status(500).json({ message: 'Error fetching blood groups' });
  }
});

// Submit contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message, user_agent } = req.body;
    
    // Get the client's IP address
    let clientIP = req.headers['x-forwarded-for'] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    // Handle comma-separated IP addresses (from proxies like Cloudflare)
    if (clientIP && clientIP.includes(',')) {
      clientIP = clientIP.split(',')[0].trim();
    }
    
    // Remove IPv6 prefix if present
    if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.substring(7);
    }
    
    const query = `
      INSERT INTO contact_messages (name, email, phone, subject, message, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `;
    
    const values = [name, email, phone, subject, message, clientIP, user_agent];
    const result = await pool.query(query, values);
    
    res.status(201).json({
      message: 'Message sent successfully',
      contact: result.rows[0]
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ message: 'Error sending message' });
  }
});

// Get all contact messages (admin only)
app.get('/api/admin/contact-messages', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM contact_messages ORDER BY created_at DESC';
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contact messages:', error);
    res.status(500).json({ message: 'Error fetching contact messages' });
  }
});

// Get dashboard statistics (admin only)
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    const stats = {};
    
    // Total donors
    const donorsResult = await pool.query('SELECT COUNT(*) as count FROM donors');
    stats.totalDonors = parseInt(donorsResult.rows[0].count);
    
    // Total blood requests
    const requestsResult = await pool.query('SELECT COUNT(*) as count FROM blood_requests');
    stats.totalRequests = parseInt(requestsResult.rows[0].count);
    
    // Pending requests
    const pendingResult = await pool.query('SELECT COUNT(*) as count FROM blood_requests WHERE status = $1', ['pending']);
    stats.pendingRequests = parseInt(pendingResult.rows[0].count);
    
    // Contact messages
    const messagesResult = await pool.query('SELECT COUNT(*) as count FROM contact_messages');
    stats.totalMessages = parseInt(messagesResult.rows[0].count);
    
    // Blood group distribution
    const bloodGroupResult = await pool.query(`
      SELECT bg.blood_group, COUNT(d.id) as donor_count
      FROM blood_groups bg
      LEFT JOIN donors d ON bg.id = d.blood_group_id
      GROUP BY bg.id, bg.blood_group
      ORDER BY bg.id
    `);
    stats.bloodGroupDistribution = bloodGroupResult.rows;
    
    // Recent activities
    const recentDonors = await pool.query(`
      SELECT fullname, created_at FROM donors 
      ORDER BY created_at DESC LIMIT 5
    `);
    const recentRequests = await pool.query(`
      SELECT patient_name, urgency_level, created_at FROM blood_requests 
      ORDER BY created_at DESC LIMIT 5
    `);
    
    stats.recentDonors = recentDonors.rows;
    stats.recentRequests = recentRequests.rows;
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ message: 'Error fetching dashboard data' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start server
app.listen(port, () => {
  console.log(`RedConnect API server running on port ${port}`);
});

module.exports = app;
