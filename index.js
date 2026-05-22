const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const excelJS = require('exceljs');
const jwt = require('jsonwebtoken');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// লাইভ ডাটাবেস (Supabase) কানেকশন পুল
const pool = new Pool({
  connectionString: process.env.PG_URI,
  ssl: {
    rejectUnauthorized: false
  }
});

// ডাটাবেস টেবিল ইনিশিয়ালাইজেশন
pool.connect()
  .then(() => {
    console.log('PostgreSQL successfully connected!');
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        product_image TEXT,
        product_link TEXT NOT NULL,
        keyword VARCHAR(255),
        store_name VARCHAR(255),
        product_price NUMERIC(10, 2) NOT NULL,
        order_qty INT NOT NULL DEFAULT 0,
        status VARCHAR(50) DEFAULT 'available'
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id) ON DELETE CASCADE,
        order_number VARCHAR(100) NOT NULL,
        order_screenshot_1 TEXT,
        order_screenshot_2 TEXT,
        review_screenshot_1 TEXT,
        review_screenshot_2 TEXT,
        paypal_email VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending', 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    return pool.query(createTablesQuery);
  })
  .then(() => console.log('Production Database tables are ready!'))
  .catch((err) => console.error('Database Connection Error:', err.message));


// URL থেকে ইমেজ ডাউনলোড করে Buffer-এ রূপান্তর করার হেল্পার ফাংশন
async function fetchImageBuffer(url) {
  try {
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const contentType = response.headers.get('content-type');
    let extension = 'png'; 
    if (contentType && contentType.includes('jpeg')) extension = 'jpeg';
    if (contentType && contentType.includes('jpg')) extension = 'jpeg';
    if (contentType && contentType.includes('gif')) extension = 'gif';
    if (contentType && contentType.includes('webp')) extension = 'webp';
    
    return { buffer, extension };
  } catch (err) {
    console.error(`Failed to download image from ${url}:`, err.message);
    return null;
  }
}

// ==========================================
// 0. ADMIN LOGIN API
// ==========================================
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin', email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.status(200).json({ success: true, message: 'Login successful!', token });
  } else {
    return res.status(401).json({ success: false, message: 'Invalid email or password!' });
  }
});

// ==========================================
// Middleware: Verify Admin Token
// ==========================================
const verifyAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]; 
  if (!token) return res.status(401).json({ success: false, message: 'Access Denied.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') next();
    else res.status(403).json({ success: false, message: 'Forbidden access.' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Invalid or expired token.' });
  }
};

// ==========================================
// 1. ADD NEW PRODUCT API
// ==========================================
app.post('/api/products', verifyAdmin, async (req, res) => {
  try {
    const { product_image, product_link, keyword, store_name, product_price, order_qty } = req.body;
    const status = order_qty > 0 ? 'available' : 'not_available';

    const newProduct = await pool.query(
      `INSERT INTO products (product_image, product_link, keyword, store_name, product_price, order_qty, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [product_image, product_link, keyword, store_name, product_price, order_qty, status]
    );

    res.status(201).json({ success: true, message: 'Product added!', product: newProduct.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 2. SUBMIT NEW ORDER API
// ==========================================
app.post('/api/orders', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email } = req.body;

    const productCheck = await client.query('SELECT order_qty FROM products WHERE id = $1', [product_id]);
    if (productCheck.rows.length === 0 || productCheck.rows[0].order_qty <= 0) {
      throw new Error('Product is out of stock or not available');
    }

    const newOrder = await client.query(
      `INSERT INTO orders (product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email]
    );

    await client.query(
      `UPDATE products 
       SET order_qty = order_qty - 1, 
           status = CASE WHEN order_qty - 1 <= 0 THEN 'not_available' ELSE status END
       WHERE id = $1`,
      [product_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Order submitted successfully!', order: newOrder.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 3. SUBMIT REVIEW API
// ==========================================
app.put('/api/orders/:id/review', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { review_screenshot_1, review_screenshot_2 } = req.body;

    const updatedOrder = await pool.query(
      `UPDATE orders 
       SET review_screenshot_1 = $1, review_screenshot_2 = $2, status = 'review_submitted' 
       WHERE id = $3 RETURNING *`,
      [review_screenshot_1, review_screenshot_2, id]
    );

    if (updatedOrder.rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });
    res.status(200).json({ success: true, message: 'Review submitted!', order: updatedOrder.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 4. EXPORT TO EXCEL API (UPDATED: 2 Columns, Side-by-Side Images, No Links)
// ==========================================
app.get('/api/orders/export', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ordersToExport = await client.query(
      `SELECT o.id, o.order_number, o.order_screenshot_1, o.order_screenshot_2, 
              o.review_screenshot_1, o.review_screenshot_2, o.paypal_email, 
              o.created_at, p.product_price 
       FROM orders o
       JOIN products p ON o.product_id = p.id
       WHERE o.status = 'review_submitted'`
    );

    if (ordersToExport.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'No new reviews to export.' });
    }

    const workbook = new excelJS.Workbook();
    const worksheet = workbook.addWorksheet('Submitted Reviews');

    // কলাম সেটআপ (ইমেজের জন্য মাত্র ২টি চওড়া কলাম রাখা হয়েছে)
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Order Number', key: 'order_number', width: 25 },
      { header: 'Order Screenshots', key: 'order_ss', width: 45 },  // কলাম ৩: অর্ডার ইমেজ
      { header: 'Review Screenshots', key: 'review_ss', width: 45 }, // কলাম ৪: রিভিউ ইমেজ
      { header: 'Product Price', key: 'price', width: 15 },
      { header: 'PayPal Mail', key: 'paypal', width: 30 }
    ];

    const orderIds = [];
    
    for (let i = 0; i < ordersToExport.rows.length; i++) {
      const order = ordersToExport.rows[i];
      orderIds.push(order.id);

      const currentRowIndex = i + 2; 
      // এখানে রো তৈরি করা হচ্ছে, কোনো ইমেজের 'লিংক' টেক্সট হিসেবে দেওয়া হচ্ছে না
      worksheet.addRow({
        date: new Date(order.created_at).toLocaleDateString(),
        order_number: order.order_number,
        price: `$${order.product_price}`,
        paypal: order.paypal_email
      });

      // ইমেজের জায়গা দেওয়ার জন্য রো-এর উচ্চতা ১৩০ করা হয়েছে
      worksheet.getRow(currentRowIndex).height = 130;

      // ছবিগুলো পাশাপাশি বসানোর লজিক (একই কলামের ভেতর)
      const imagePlacements = [
        { url: order.order_screenshot_1, colIndex: 3, offsetX: 0.1 },   // Order SS 1 (বামে)
        { url: order.order_screenshot_2, colIndex: 3, offsetX: 3.5 },   // Order SS 2 (ডানে)
        { url: order.review_screenshot_1, colIndex: 4, offsetX: 0.1 },  // Review SS 1 (বামে)
        { url: order.review_screenshot_2, colIndex: 4, offsetX: 3.5 }   // Review SS 2 (ডানে)
      ];

      for (const img of imagePlacements) {
        if (img.url && !img.url.startsWith('blob:')) {
          const imgData = await fetchImageBuffer(img.url);
          if (imgData) {
            const imageId = workbook.addImage({ buffer: imgData.buffer, extension: imgData.extension });
            worksheet.addImage(imageId, {
              tl: { col: img.colIndex - 1 + img.offsetX, row: currentRowIndex - 1 + 0.1 }, 
              ext: { width: 150, height: 110 },
              editAs: 'oneCell' 
            });
          }
        }
      }
    }

    await client.query(`UPDATE orders SET status = 'completed' WHERE id = ANY($1::int[])`, [orderIds]);
    await client.query('COMMIT');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + `Reviews_Report_${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.status(200).end();

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Export Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to export excel.' });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. GET ALL PRODUCTS API
// ==========================================
app.get('/api/products', verifyAdmin, async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.status(200).json({ success: true, products: products.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 6. UPDATE PRODUCT API
// ==========================================
app.put('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { product_image, product_link, keyword, store_name, product_price, order_qty } = req.body;
    const status = order_qty > 0 ? 'available' : 'not_available';

    const updatedProduct = await pool.query(
      `UPDATE products 
       SET product_image = $1, product_link = $2, keyword = $3, store_name = $4, product_price = $5, order_qty = $6, status = $7 
       WHERE id = $8 RETURNING *`,
      [product_image, product_link, keyword, store_name, product_price, order_qty, status, id]
    );

    if (updatedProduct.rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    res.status(200).json({ success: true, message: 'Product updated!', product: updatedProduct.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 7. DELETE PRODUCT API
// ==========================================
app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deletedProduct = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [id]);
    if (deletedProduct.rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    res.status(200).json({ success: true, message: 'Product deleted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 8. GET ALL ORDERS API
// ==========================================
app.get('/api/orders', verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM orders ORDER BY created_at DESC';
    let values = [];

    if (status) {
      query = 'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC';
      values = [status];
    }

    const orders = await pool.query(query, values);
    res.status(200).json({ success: true, orders: orders.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ==========================================
// 9. DELETE ORDER API
// ==========================================
app.delete('/api/orders/:id', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    const order = await client.query('SELECT product_id, status FROM orders WHERE id = $1', [id]);
    if (order.rows.length === 0) throw new Error('Order not found');

    await client.query('DELETE FROM orders WHERE id = $1', [id]);
    
    if (order.rows[0].status !== 'completed') {
      await client.query(`UPDATE products SET order_qty = order_qty + 1, status = 'available' WHERE id = $1`, [order.rows[0].product_id]);
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Order deleted successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================
app.get('/', (req, res) => res.send('Secure Order Management API is live!'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Secure Server is running on port: ${PORT}`));