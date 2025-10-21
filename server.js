// src/server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/shop-categories', require('./src/routes/shopCategories'));
app.use('/api/categories', require('./src/routes/categories')); // catégories PRODUIT
app.use('/api/shops', require('./src/routes/shops'));
app.use('/api/products', require('./src/routes/products'));
app.use('/api/orders', require('./src/routes/orders'));

const port = process.env.PORT || Number(process.env.APP_PORT || 4000);
app.listen(port, () => {
  console.log(`API listening on port ${port} (env: ${process.env.NODE_ENV || 'dev'})`);
});
