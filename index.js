const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function generateRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'MP-';
  for (let i = 0; i < 4; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  ref += '-';
  for (let i = 0; i < 4; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

function checkHost(req, res, next) {
  if (req.headers['x-host-password'] !== process.env.HOST_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// Public - get competition stats
app.get('/api/competition', async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    if (!c.rows.length) return res.json({ error: 'No competition' });
    const comp = c.rows[0];
    const s = await pool.query(
      'SELECT COUNT(DISTINCT username) as players, SUM(qty) as tickets, SUM(CASE WHEN paid THEN qty ELSE 0 END) as paid_tickets FROM entries WHERE competition_id=$1',
      [comp.id]
    );
    const st = s.rows[0];
    res.json({
      id: comp.id,
      name: comp.name,
      endDate: comp.end_date,
      price: parseFloat(comp.price),
      live: comp.live,
      potRevealed: comp.pot_revealed,
      winnerDrawn: comp.winner_drawn,
      winnerName: comp.winner_name,
      players: parseInt(st.players) || 0,
      tickets: parseInt(st.tickets) || 0,
      paidTickets: parseInt(st.paid_tickets) || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public - submit entry
app.post('/api/entry', async (req, res) => {
  try {
    const { username, platform, qty } = req.body;
    if (!username || !qty) return res.status(400).json({ error: 'Missing fields' });
    const c = await pool.query('SELECT * FROM competitions WHERE live=true ORDER BY id DESC LIMIT 1');
    if (!c.rows.length) return res.status(400).json({ error: 'No active competition' });
    const comp = c.rows[0];
    if (new Date() > new Date(comp.end_date)) return res.status(400).json({ error: 'Competition has ended' });
    let ref = generateRef();
    for (let i = 0; i < 10; i++) {
      const ex = await pool.query('SELECT id FROM entries WHERE ref_code=$1', [ref]);
      if (!ex.rows.length) break;
      ref = generateRef();
    }
    await pool.query(
      'INSERT INTO entries (competition_id, username, platform, qty, ref_code) VALUES ($1,$2,$3,$4,$5)',
      [comp.id, username, platform || 'Unknown', qty, ref]
    );
    res.json({ success: true, refCode: ref });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Host - get all entries
app.get('/api/host/entries', checkHost, async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    if (!c.rows.length) return res.json({ entries: [] });
    const e = await pool.query(
      'SELECT * FROM entries WHERE competition_id=$1 ORDER BY created_at DESC',
      [c.rows[0].id]
    );
    res.json({ competition: c.rows[0], entries: e.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Host - mark paid
app.post('/api/host/mark-paid', checkHost, async (req, res) => {
  try {
    const { refCode, paid, paymentMethod } = req.body;
    await pool.query(
      'UPDATE entries SET paid=$1, payment_method=$2 WHERE ref_code=$3',
      [paid, paymentMethod || 'Manual', refCode]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Host - draw winner
app.post('/api/host/draw-winner', checkHost, async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    const comp = c.rows[0];
    const entries = await pool.query(
      'SELECT username, qty, ref_code FROM entries WHERE competition_id=$1 AND paid=true',
      [comp.id]
    );
    if (!entries.rows.length) return res.status(400).json({ error: 'No paid entries' });
    const weighted = [];
    for (const e of entries.rows) {
      for (let i = 0; i < e.qty; i++) weighted.push(e);
    }
    const winner = weighted[Math.floor(Math.random() * weighted.length)];
    const totalPaid = entries.rows.reduce((s, e) => s + parseInt(e.qty), 0);
    const pot = totalPaid * parseFloat(comp.price);
    const prize = pot * (1 - comp.host_cut / 100);
    const cut = pot * (comp.host_cut / 100);
    await pool.query(
      'UPDATE competitions SET winner_drawn=true, winner_name=$1, pot_revealed=true WHERE id=$2',
      [winner.username, comp.id]
    );
    res.json({
      success: true,
      winner: winner.username,
      refCode: winner.ref_code,
      totalEntries: weighted.length,
      prizePot: prize.toFixed(2),
      hostCut: cut.toFixed(2)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Host - new competition
app.post('/api/host/new-competition', checkHost, async (req, res) => {
  try {
    const { endDate, name } = req.body;
    const d = new Date();
    const days = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + days);
    d.setHours(20, 0, 0, 0);
    await pool.query(
      'INSERT INTO competitions (name, end_date, price, host_cut, live) VALUES ($1,$2,0.10,30,true)',
      [name || 'Mystery Pot Challenge', endDate || d]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Mystery Pot server running on port ' + PORT));
