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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/shop-categories', require('./routes/shopCategories'));
app.use('/api/categories', require('./routes/categories')); // catégories PRODUIT
app.use('/api/shops', require('./routes/shops'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));

const port = Number(process.env.APP_PORT || 4000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
