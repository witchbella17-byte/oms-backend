const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const excelJS = require('exceljs');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.PG_URI,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(async (client) => {
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
    await client.query(createTablesQuery);
    
    try {
      await client.query(`ALTER TABLE orders ADD COLUMN current_price NUMERIC(10, 2) DEFAULT 0.00;`);
    } catch (e) {}
    
    // NEW: Auto add 'order_date' column
    try {
      await client.query(`ALTER TABLE orders ADD COLUMN order_date DATE;`);
      console.log("Added order_date column to orders table.");
    } catch (e) {}

    client.release();
    console.log('Production Database tables are ready!');
  })
  .catch((err) => console.error('Database Connection Error:', err.message));


async function fetchImageBuffer(url) {
  try {
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type');
    let extension = 'png'; 
    if (contentType && (contentType.includes('jpeg') || contentType.includes('jpg'))) extension = 'jpeg';
    if (contentType && contentType.includes('gif')) extension = 'gif';
    if (contentType && contentType.includes('webp')) extension = 'webp';
    return { buffer, extension };
  } catch (err) {
    console.error(`Failed to download image:`, err.message);
    return null;
  }
}

const verifyAdmin = (req, res, next) => {
  next(); 
};

// 1. ADD NEW PRODUCT API
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

// 2. SUBMIT NEW ORDER API (UPDATED with order_date)
app.post('/api/orders', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email, current_price, order_date } = req.body;

    const productCheck = await client.query('SELECT order_qty FROM products WHERE id = $1', [product_id]);
    if (productCheck.rows.length === 0 || productCheck.rows[0].order_qty <= 0) {
      throw new Error('Product is out of stock or not available');
    }

    const finalOrderDate = order_date || new Date().toISOString().split('T')[0];

    const newOrder = await client.query(
      `INSERT INTO orders (product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email, status, current_price, order_date) 
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING *`,
      [product_id, order_number, order_screenshot_1, order_screenshot_2, paypal_email, current_price, finalOrderDate]
    );

    await client.query(
      `UPDATE products 
       SET order_qty = order_qty - 1, 
           status = CASE WHEN order_qty - 1 <= 0 THEN 'not_available' ELSE status END
       WHERE id = $1`,
      [product_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Order submitted!', order: newOrder.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. SUBMIT REVIEW API
app.put('/api/orders/:id/review', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { review_screenshot_1, review_screenshot_2 } = req.body;
    const updatedOrder = await pool.query(
      `UPDATE orders SET review_screenshot_1 = $1, review_screenshot_2 = $2, status = 'review_submitted' 
       WHERE id = $3 RETURNING *`,
      [review_screenshot_1, review_screenshot_2, id]
    );
    if (updatedOrder.rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });
    res.status(200).json({ success: true, message: 'Review submitted!', order: updatedOrder.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 4. EXPORT TO EXCEL API (UPDATED for order_date and auto #)
app.post('/api/orders/export', verifyAdmin, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No orders selected.' });
    }

    const ordersToExport = await pool.query(
      `SELECT o.id, o.order_number, o.order_screenshot_1, o.order_screenshot_2, 
              o.review_screenshot_1, o.review_screenshot_2, o.paypal_email, 
              o.created_at, o.order_date, o.current_price, p.product_price 
       FROM orders o
       JOIN products p ON o.product_id = p.id
       WHERE o.id = ANY($1::int[])`, [orderIds]
    );

    if (ordersToExport.rows.length === 0) return res.status(404).json({ success: false, message: 'Orders not found.' });

    const workbook = new excelJS.Workbook();
    const worksheet = workbook.addWorksheet('Submitted Reviews');

    worksheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Order Number', key: 'order_number', width: 18 },
      { header: 'Order Screenshots', key: 'order_ss', width: 25 }, 
      { header: 'Review Screenshots', key: 'review_ss', width: 25 }, 
      { header: 'Current Price', key: 'price', width: 9 },
      { header: 'PayPal Mail', key: 'paypal', width: 30 }
    ];

    for (let i = 0; i < ordersToExport.rows.length; i++) {
      const order = ordersToExport.rows[i];
      const currentRowIndex = i + 2; 
      
      const priceToDisplay = order.current_price !== null ? order.current_price : order.product_price;
      
      // Auto formatting date and Hash
      const displayDate = order.order_date ? new Date(order.order_date).toLocaleDateString() : new Date(order.created_at).toLocaleDateString();
      const cleanOrderNumber = order.order_number.replace(/^#+/, ''); // Removes any existing hashes to prevent ##
      const finalOrderNumber = `#${cleanOrderNumber}`;

      worksheet.addRow({
        date: displayDate,
        order_number: finalOrderNumber,
        price: `$${priceToDisplay}`,
        paypal: order.paypal_email
      });
      worksheet.getRow(currentRowIndex).height = 130;

      const imagePlacements = [
        { url: order.order_screenshot_1, colIndex: 3, offsetCol: 0.02 }, 
        { url: order.order_screenshot_2, colIndex: 3, offsetCol: 0.52 }, 
        { url: order.review_screenshot_1, colIndex: 4, offsetCol: 0.02 },
        { url: order.review_screenshot_2, colIndex: 4, offsetCol: 0.52 }
      ];

      for (const img of imagePlacements) {
        if (img.url && !img.url.startsWith('blob:')) {
          const imgData = await fetchImageBuffer(img.url);
          if (imgData) {
            const imageId = workbook.addImage({ buffer: imgData.buffer, extension: imgData.extension });
            worksheet.addImage(imageId, {
              tl: { col: img.colIndex - 1 + img.offsetCol, row: currentRowIndex - 1 + 0.1 }, 
              ext: { width: 140, height: 110 },
              editAs: 'oneCell' 
            });
          }
        }
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + `Reviews_Export_${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.status(200).end();

  } catch (err) {
    console.error('Export Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to export excel.' });
  }
});

// 4.5 MARK AS DONE API 
app.put('/api/orders/mark-done', verifyAdmin, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || orderIds.length === 0) return res.status(400).json({ success: false, message: 'No orders selected.' });
    await pool.query(`UPDATE orders SET status = 'completed' WHERE id = ANY($1::int[])`, [orderIds]);
    res.status(200).json({ success: true, message: 'Orders marked as completed!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 4.6 UNDO ORDER API 
app.put('/api/orders/:id/undo', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE orders SET status = 'review_submitted' WHERE id = $1`, [id]);
    res.status(200).json({ success: true, message: 'Order status reverted to ready!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 5. GET ALL PRODUCTS
app.get('/api/products', verifyAdmin, async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.status(200).json({ success: true, products: products.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 6. UPDATE PRODUCT
app.put('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { product_image, product_link, keyword, store_name, product_price, order_qty } = req.body;
    const status = order_qty > 0 ? 'available' : 'not_available';
    const updatedProduct = await pool.query(
      `UPDATE products SET product_image=$1, product_link=$2, keyword=$3, store_name=$4, product_price=$5, order_qty=$6, status=$7 WHERE id=$8 RETURNING *`,
      [product_image, product_link, keyword, store_name, product_price, order_qty, status, id]
    );
    res.status(200).json({ success: true, product: updatedProduct.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 7. DELETE PRODUCT
app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 8. GET ALL ORDERS
app.get('/api/orders', verifyAdmin, async (req, res) => {
  try {
    const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.status(200).json({ success: true, orders: orders.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// 9. DELETE ORDER
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
    res.status(200).json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => res.send('Secure OMS API is live!'));
app.listen(process.env.PORT || 5000, () => console.log(`Server running`));