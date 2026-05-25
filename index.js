const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HOST_CUT = 30;
const PRICES = { pot:100, spin:100, scratch:100, hangman:100, hl:100, darts:100 };
const TICKETS = {
  pot:10, spin:5, scratch:5,
  hangman_solve:15, hangman_fail:5,
  hl_attempt:1, hl_qualify:5,
  darts_0_30:3, darts_31_60:5, darts_61_90:8,
  darts_91_120:10, darts_121_150:13, darts_151_179:15, darts_180:20,
  referral:3
};

function generateRef(prefix='MP'){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r=prefix+'-';
  for(let i=0;i<4;i++)r+=c[Math.floor(Math.random()*c.length)];
  r+='-';
  for(let i=0;i<4;i++)r+=c[Math.floor(Math.random()*c.length)];
  return r;
}

function generateReferralCode(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r='';for(let i=0;i<8;i++)r+=c[Math.floor(Math.random()*c.length)];
  return r;
}

function getDartsTickets(score){
  if(score===180)return TICKETS.darts_180;
  if(score>=151)return TICKETS.darts_151_179;
  if(score>=121)return TICKETS.darts_121_150;
  if(score>=91)return TICKETS.darts_91_120;
  if(score>=61)return TICKETS.darts_61_90;
  if(score>=31)return TICKETS.darts_31_60;
  return TICKETS.darts_0_30;
}

function hashPassword(password){
  return crypto.createHash('sha256').update(password+process.env.HOST_PASSWORD).digest('hex');
}

function checkHost(req,res,next){
  if(req.headers['x-host-password']!==process.env.HOST_PASSWORD)
    return res.status(401).json({error:'Unauthorised'});
  next();
}

function checkAuth(req,res,next){
  const token=req.headers['x-player-token'];
  if(!token)return res.status(401).json({error:'Not logged in'});
  pool.query('SELECT * FROM players WHERE session_token=$1 AND token_expires>NOW()',[token])
    .then(r=>{
      if(!r.rows.length)return res.status(401).json({error:'Session expired'});
      req.player=r.rows[0];
      next();
    }).catch(e=>res.status(500).json({error:e.message}));
}

// ── DB INIT ──────────────────────────────────────────
async function initDB(){
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS competitions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'Mystery Pot Challenge',
        end_date TIMESTAMP NOT NULL,
        price DECIMAL(10,2) DEFAULT 1.00,
        host_cut INTEGER DEFAULT 30,
        live BOOLEAN DEFAULT true,
        pot_revealed BOOLEAN DEFAULT false,
        winner_drawn BOOLEAN DEFAULT false,
        winner_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        platform VARCHAR(100) DEFAULT 'Unknown',
        wallet_balance DECIMAL(10,2) DEFAULT 0.00,
        total_deposited DECIMAL(10,2) DEFAULT 0.00,
        total_withdrawn DECIMAL(10,2) DEFAULT 0.00,
        total_won DECIMAL(10,2) DEFAULT 0.00,
        referral_code VARCHAR(20) UNIQUE,
        referred_by VARCHAR(20),
        session_token VARCHAR(255),
        token_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id),
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description VARCHAR(255),
        reference VARCHAR(50),
        stripe_session_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id),
        username VARCHAR(100),
        amount DECIMAL(10,2) NOT NULL,
        paypal_email VARCHAR(255),
        payment_details TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        competition_id INTEGER REFERENCES competitions(id),
        username VARCHAR(255) NOT NULL,
        platform VARCHAR(100) DEFAULT 'Unknown',
        game VARCHAR(50) DEFAULT 'pot',
        qty INTEGER DEFAULT 1,
        paid BOOLEAN DEFAULT false,
        payment_method VARCHAR(50),
        stripe_session_id VARCHAR(255),
        ref_code VARCHAR(20) UNIQUE NOT NULL,
        referral_code VARCHAR(20),
        referred_by VARCHAR(20),
        player_id INTEGER REFERENCES players(id),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referral_code VARCHAR(20) UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL,
        platform VARCHAR(100),
        bonus_tickets INTEGER DEFAULT 0,
        friends_referred INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS darts_leaderboard (
        id SERIAL PRIMARY KEY,
        competition_id INTEGER REFERENCES competitions(id),
        username VARCHAR(255) NOT NULL,
        platform VARCHAR(100),
        score INTEGER NOT NULL,
        tickets INTEGER NOT NULL,
        ref_code VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS spin_prizes (
        id SERIAL PRIMARY KEY,
        competition_id INTEGER REFERENCES competitions(id),
        username VARCHAR(255) NOT NULL,
        prize_amount DECIMAL(10,2),
        ref_code VARCHAR(20),
        paid BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS scratch_prizes (
        id SERIAL PRIMARY KEY,
        competition_id INTEGER REFERENCES competitions(id),
        username VARCHAR(255) NOT NULL,
        prize_amount DECIMAL(10,2),
        symbol VARCHAR(10),
        ref_code VARCHAR(20),
        paid BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe column additions
    const alters=[
      `ALTER TABLE entries ADD COLUMN IF NOT EXISTS game VARCHAR(50) DEFAULT 'pot'`,
      `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payment_details TEXT`,
      `ALTER TABLE entries ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)`,
      `ALTER TABLE entries ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`,
      `ALTER TABLE entries ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20)`,
      `ALTER TABLE entries ADD COLUMN IF NOT EXISTS player_id INTEGER REFERENCES players(id)`,
    ];
    for(const a of alters){try{await pool.query(a);}catch(e){}}

    const existing=await pool.query('SELECT id FROM competitions LIMIT 1');
    if(!existing.rows.length){
      const d=new Date();
      const days=(6-d.getDay()+7)%7||7;
      d.setDate(d.getDate()+days);d.setHours(20,0,0,0);
      await pool.query(
        `INSERT INTO competitions (name,end_date,price,host_cut,live) VALUES ($1,$2,$3,$4,$5)`,
        ['Mystery Pot Challenge',d,1.00,30,true]
      );
    }
    console.log('Database ready!');
  }catch(e){console.error('DB init error:',e.message);}
}

// ── PLAYER AUTH ──────────────────────────────────────
app.post('/api/player/register',async(req,res)=>{
  try{
    const{username,password,platform,referredBy}=req.body;
    if(!username||!password)return res.status(400).json({error:'Username and password required'});
    if(username.length<3)return res.status(400).json({error:'Username must be at least 3 characters'});
    if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
    const exists=await pool.query('SELECT id FROM players WHERE LOWER(username)=LOWER($1)',[username]);
    if(exists.rows.length)return res.status(400).json({error:'Username already taken'});
    const hash=hashPassword(password);
    const refCode=generateReferralCode();
    const token=crypto.randomBytes(32).toString('hex');
    const expires=new Date(Date.now()+7*24*60*60*1000);
    const r=await pool.query(
      `INSERT INTO players (username,password_hash,platform,referral_code,referred_by,session_token,token_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,username,wallet_balance,referral_code`,
      [username,hash,platform||'Unknown',refCode,referredBy||null,token,expires]
    );
    const player=r.rows[0];
    // Handle referral bonus
    if(referredBy){
      const referrer=await pool.query('SELECT * FROM players WHERE referral_code=$1',[referredBy]);
      if(referrer.rows.length){
        const comp=await pool.query('SELECT id FROM competitions WHERE live=true ORDER BY id DESC LIMIT 1');
        if(comp.rows.length){
          const ref1=generateRef('RB');const ref2=generateRef('RB');
          await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code,player_id) VALUES ($1,$2,$3,'referral_bonus',3,true,'Referral',$4,$5)`,[comp.rows[0].id,referrer.rows[0].username,referrer.rows[0].platform,ref1,referrer.rows[0].id]);
          await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code,player_id) VALUES ($1,$2,$3,'referral_bonus',3,true,'Referral',$4,$5)`,[comp.rows[0].id,username,platform||'Unknown',ref2,player.id]);
        }
      }
    }
    res.json({success:true,token,player:{id:player.id,username:player.username,balance:player.wallet_balance,referralCode:player.referral_code}});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/player/login',async(req,res)=>{
  try{
    const{username,password}=req.body;
    if(!username||!password)return res.status(400).json({error:'Username and password required'});
    const hash=hashPassword(password);
    const r=await pool.query('SELECT * FROM players WHERE LOWER(username)=LOWER($1) AND password_hash=$2',[username,hash]);
    if(!r.rows.length)return res.status(401).json({error:'Wrong username or password'});
    const token=crypto.randomBytes(32).toString('hex');
    const expires=new Date(Date.now()+7*24*60*60*1000);
    await pool.query('UPDATE players SET session_token=$1,token_expires=$2 WHERE id=$3',[token,expires,r.rows[0].id]);
    const p=r.rows[0];
    res.json({success:true,token,player:{id:p.id,username:p.username,balance:parseFloat(p.wallet_balance),referralCode:p.referral_code,platform:p.platform}});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/player/logout',checkAuth,async(req,res)=>{
  await pool.query('UPDATE players SET session_token=null WHERE id=$1',[req.player.id]);
  res.json({success:true});
});

app.get('/api/player/me',checkAuth,async(req,res)=>{
  try{
    const p=req.player;
    const txns=await pool.query('SELECT * FROM wallet_transactions WHERE player_id=$1 ORDER BY created_at DESC LIMIT 20',[p.id]);
    const tickets=await pool.query(`SELECT SUM(qty) as total FROM entries WHERE player_id=$1 AND paid=true AND game!='referral_bonus'`,[p.id]);
    const withdrawals=await pool.query('SELECT * FROM withdrawal_requests WHERE player_id=$1 ORDER BY created_at DESC LIMIT 5',[p.id]);
    res.json({
      success:true,
      player:{id:p.id,username:p.username,balance:parseFloat(p.wallet_balance),referralCode:p.referral_code,platform:p.platform,totalDeposited:parseFloat(p.total_deposited),totalWithdrawn:parseFloat(p.total_withdrawn),totalWon:parseFloat(p.total_won)},
      transactions:txns.rows,
      totalTickets:parseInt(tickets.rows[0]?.total)||0,
      withdrawals:withdrawals.rows
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ── WALLET: DEPOSIT ──────────────────────────────────
app.post('/api/wallet/deposit/create',checkAuth,async(req,res)=>{
  try{
    const{amount}=req.body;
    if(!amount||amount<100)return res.status(400).json({error:'Minimum deposit £1'});
    const session=await stripe.checkout.sessions.create({
      payment_method_types:['card'],
      line_items:[{price_data:{currency:'gbp',product_data:{name:`Mystery Pot UK — Wallet Deposit`,description:`Add £${(amount/100).toFixed(2)} to your Mystery Pot wallet`},unit_amount:amount},quantity:1}],
      mode:'payment',
      success_url:`https://mysterypotuk.github.io/Mysterypotuk?wallet=deposit&session={CHECKOUT_SESSION_ID}`,
      cancel_url:`https://mysterypotuk.github.io/Mysterypotuk?wallet=cancelled`,
      metadata:{type:'wallet_deposit',player_id:req.player.id.toString(),username:req.player.username,amount:amount.toString()}
    });
    res.json({sessionId:session.id,url:session.url});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/wallet/deposit/confirm',checkAuth,async(req,res)=>{
  try{
    const{sessionId}=req.body;
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    if(session.payment_status!=='paid')return res.status(400).json({error:'Payment not completed'});
    const exists=await pool.query('SELECT id FROM wallet_transactions WHERE stripe_session_id=$1',[sessionId]);
    if(exists.rows.length)return res.json({success:true,alreadyProcessed:true});
    const amount=parseInt(session.metadata.amount)/100;
    await pool.query('UPDATE players SET wallet_balance=wallet_balance+$1,total_deposited=total_deposited+$1 WHERE id=$2',[amount,req.player.id]);
    await pool.query(`INSERT INTO wallet_transactions (player_id,type,amount,description,stripe_session_id) VALUES ($1,'deposit',$2,$3,$4)`,[req.player.id,amount,`Card deposit via Stripe`,sessionId]);
    const updated=await pool.query('SELECT wallet_balance FROM players WHERE id=$1',[req.player.id]);
    res.json({success:true,newBalance:parseFloat(updated.rows[0].wallet_balance),amount});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── WALLET: PLAY GAME ────────────────────────────────
app.post('/api/wallet/play',checkAuth,async(req,res)=>{
  try{
    const{game,dart_score,hangman_solved,qualified}=req.body;
    const cost=1.00;
    const player=req.player;
    if(parseFloat(player.wallet_balance)<cost)return res.status(400).json({error:'Insufficient balance — please deposit'});
    const comp=await pool.query('SELECT * FROM competitions WHERE live=true ORDER BY id DESC LIMIT 1');
    if(!comp.rows.length)return res.status(400).json({error:'No active competition'});
    const compId=comp.rows[0].id;
    let tickets=TICKETS[game]||5;
    if(game==='hangman')tickets=hangman_solved?TICKETS.hangman_solve:TICKETS.hangman_fail;
    if(game==='darts'&&dart_score)tickets=getDartsTickets(parseInt(dart_score));
    if(game==='hl')tickets=qualified?TICKETS.hl_qualify+TICKETS.hl_attempt:TICKETS.hl_attempt;
    const prefixes={pot:'MP',spin:'MS',scratch:'SC',hangman:'HW',hl:'HL',darts:'DT'};
    const ref=generateRef(prefixes[game]||'MP');
    // Deduct from wallet
    await pool.query('UPDATE players SET wallet_balance=wallet_balance-$1 WHERE id=$2',[cost,player.id]);
    await pool.query(`INSERT INTO wallet_transactions (player_id,type,amount,description,reference) VALUES ($1,'game',$2,$3,$4)`,[player.id,-cost,`${game} game`,ref]);
    // Create entry
    await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code,player_id) VALUES ($1,$2,$3,$4,$5,true,'Wallet',$6,$7)`,[compId,player.username,player.platform,game,tickets,ref,player.id]);
    // Darts leaderboard
    if(game==='darts'&&dart_score)await pool.query('INSERT INTO darts_leaderboard (competition_id,username,platform,score,tickets,ref_code) VALUES ($1,$2,$3,$4,$5,$6)',[compId,player.username,player.platform,parseInt(dart_score),tickets,ref]);
    const updated=await pool.query('SELECT wallet_balance FROM players WHERE id=$1',[player.id]);
    res.json({success:true,refCode:ref,tickets,newBalance:parseFloat(updated.rows[0].wallet_balance)});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── WALLET: CREDIT WIN ───────────────────────────────
async function creditWinToWallet(playerId,amount,description){
  try{
    await pool.query('UPDATE players SET wallet_balance=wallet_balance+$1,total_won=total_won+$1 WHERE id=$2',[amount,playerId]);
    await pool.query(`INSERT INTO wallet_transactions (player_id,type,amount,description) VALUES ($1,'win',$2,$3)`,[playerId,amount,description]);
  }catch(e){console.error('Credit win error:',e.message);}
}

// ── WALLET: WITHDRAWAL REQUEST ───────────────────────
app.post('/api/wallet/withdraw',checkAuth,async(req,res)=>{
  try{
    const{amount,paymentMethod,paypalEmail,bankName,sortCode,accountNumber}=req.body;
    const player=req.player;

    // Must have played at least 1 game
    const played=await pool.query(
      `SELECT COUNT(*) as cnt FROM entries WHERE player_id=$1 AND game NOT IN ('referral_bonus','hl_bonus','darts_bonus')`,
      [player.id]
    );
    if(parseInt(played.rows[0].cnt)<1){
      return res.status(400).json({error:'You must play at least 1 game before withdrawing!'});
    }

    if(!amount||amount<2)return res.status(400).json({error:'Minimum withdrawal is £2'});
    if(parseFloat(player.wallet_balance)-amount<1)return res.status(400).json({error:'You must keep at least £1 in your wallet'});
    if(parseFloat(player.wallet_balance)<amount)return res.status(400).json({error:'Insufficient balance'});

    // Check 1 withdrawal per 24 hours
    const recentWr=await pool.query(
      `SELECT id FROM withdrawal_requests WHERE player_id=$1 AND created_at>NOW()-INTERVAL '24 hours' AND status='pending'`,
      [player.id]
    );
    if(recentWr.rows.length){
      return res.status(400).json({error:'You can only request 1 withdrawal per 24 hours'});
    }

    // Validate payment method details
    if(paymentMethod==='paypal'&&!paypalEmail)return res.status(400).json({error:'PayPal email required'});
    if(paymentMethod==='bank'){
      if(!bankName||!sortCode||!accountNumber)return res.status(400).json({error:'Full bank details required'});
      if(!/^\d{2}-?\d{2}-?\d{2}$/.test(sortCode.replace(/\s/g,'')))return res.status(400).json({error:'Invalid sort code format'});
      if(!/^\d{8}$/.test(accountNumber.replace(/\s/g,'')))return res.status(400).json({error:'Account number must be 8 digits'});
    }

    // Build description
    let description='';
    let paymentDetails='';
    if(paymentMethod==='paypal'){
      description=`PayPal withdrawal to ${paypalEmail}`;
      paymentDetails=JSON.stringify({method:'paypal',paypalEmail});
    } else {
      description=`Bank transfer to ${bankName} — ${sortCode}`;
      paymentDetails=JSON.stringify({method:'bank',bankName,sortCode:sortCode.replace(/\s/g,''),accountNumber:accountNumber.replace(/\s/g,'')});
    }

    // Deduct from wallet
    await pool.query('UPDATE players SET wallet_balance=wallet_balance-$1 WHERE id=$2',[amount,player.id]);
    await pool.query(
      `INSERT INTO wallet_transactions (player_id,type,amount,description,status) VALUES ($1,'withdrawal',$2,$3,'pending')`,
      [player.id,-amount,description]
    );
    await pool.query(
      `INSERT INTO withdrawal_requests (player_id,username,amount,paypal_email,status,payment_details) VALUES ($1,$2,$3,$4,'pending',$5)`,
      [player.id,player.username,amount,paypalEmail||null,paymentDetails]
    );

    const method=paymentMethod==='bank'?'bank transfer':'PayPal';
    res.json({success:true,message:`Withdrawal of £${amount.toFixed(2)} requested via ${method}! You'll receive it within 24 hours.`});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PUBLIC: COMPETITION STATS ────────────────────────
app.get('/api/competition',async(req,res)=>{
  try{
    const c=await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.json({error:'No competition'});
    const comp=c.rows[0];
    const s=await pool.query(`SELECT COUNT(DISTINCT username) as players,SUM(qty) as tickets,SUM(CASE WHEN paid THEN qty ELSE 0 END) as paid_tickets,SUM(CASE WHEN paid AND game='pot' THEN qty ELSE 0 END) as pot_tickets FROM entries WHERE competition_id=$1`,[comp.id]);
    const st=s.rows[0];
    const potTickets=parseInt(st.pot_tickets)||0;
    const potAmount=(potTickets*1.00*(1-HOST_CUT/100)).toFixed(2);
    res.json({id:comp.id,name:comp.name,endDate:comp.end_date,price:parseFloat(comp.price),live:comp.live,potRevealed:comp.pot_revealed,winnerDrawn:comp.winner_drawn,winnerName:comp.winner_name,players:parseInt(st.players)||0,tickets:parseInt(st.tickets)||0,paidTickets:parseInt(st.paid_tickets)||0,potAmount});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PUBLIC: DARTS LEADERBOARD ────────────────────────
app.get('/api/darts/leaderboard',async(req,res)=>{
  try{
    const c=await pool.query('SELECT id FROM competitions ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.json({leaderboard:[]});
    const lb=await pool.query('SELECT username,platform,score,tickets,created_at FROM darts_leaderboard WHERE competition_id=$1 ORDER BY score DESC LIMIT 20',[c.rows[0].id]);
    res.json({leaderboard:lb.rows});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PUBLIC: REFERRAL LOOKUP ──────────────────────────
app.get('/api/referral/:code',async(req,res)=>{
  try{
    const r=await pool.query('SELECT username FROM players WHERE referral_code=$1',[req.params.code]);
    if(!r.rows.length)return res.json({valid:false});
    res.json({valid:true,username:r.rows[0].username});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── STRIPE: CREATE SESSION (guest) ───────────────────
app.post('/api/stripe/create-session',async(req,res)=>{
  try{
    const{game,username,platform,metadata,successUrl,cancelUrl}=req.body;
    if(!game||!username)return res.status(400).json({error:'Missing fields'});
    const amount=PRICES[game]||100;
    const gameNames={pot:'Mystery Pot — 10 Draw Tickets',spin:'Mystery Spin — Instant Win + 5 Tickets',scratch:'Mystery Scratch — Instant Win + 5 Tickets',hangman:'Mystery Hangman — Up to 15 Tickets',hl:'Higher or Lower — Draw Tickets',darts:'Mystery Darts — Draw Tickets'};
    const session=await stripe.checkout.sessions.create({
      payment_method_types:['card'],
      line_items:[{price_data:{currency:'gbp',product_data:{name:gameNames[game]||'Mystery Pot UK',description:'mysterypotuk.netlify.app — Draw every Saturday 8pm'},unit_amount:amount},quantity:1}],
      mode:'payment',
      success_url:successUrl||`https://mysterypotuk.github.io/Mysterypotuk?payment=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:cancelUrl||`https://mysterypotuk.github.io/Mysterypotuk?payment=cancelled`,
      metadata:{game,username,platform:platform||'Unknown',...metadata}
    });
    res.json({sessionId:session.id,url:session.url});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── STRIPE: CONFIRM PAYMENT (guest) ──────────────────
app.post('/api/stripe/confirm',async(req,res)=>{
  try{
    const{sessionId}=req.body;
    if(!sessionId)return res.status(400).json({error:'Missing session ID'});
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    if(session.payment_status!=='paid')return res.status(400).json({error:'Payment not completed'});
    const existing=await pool.query('SELECT id,ref_code FROM entries WHERE stripe_session_id=$1',[sessionId]);
    if(existing.rows.length)return res.json({success:true,alreadyProcessed:true,refCode:existing.rows[0].ref_code});
    const{game,username,platform,referred_by,dart_score,hangman_solved}=session.metadata;
    const c=await pool.query('SELECT * FROM competitions WHERE live=true ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.status(400).json({error:'No active competition'});
    const comp=c.rows[0];
    let tickets=TICKETS[game]||5;
    if(game==='hangman')tickets=hangman_solved==='true'?TICKETS.hangman_solve:TICKETS.hangman_fail;
    if(game==='darts'&&dart_score)tickets=getDartsTickets(parseInt(dart_score));
    const prefixes={pot:'MP',spin:'MS',scratch:'SC',hangman:'HW',hl:'HL',darts:'DT'};
    let ref=generateRef(prefixes[game]||'MP');
    let refCode=generateReferralCode();
    const exRef=await pool.query('SELECT referral_code FROM referrals WHERE username=$1',[username]);
    if(exRef.rows.length)refCode=exRef.rows[0].referral_code;
    else await pool.query('INSERT INTO referrals (referral_code,username,platform) VALUES ($1,$2,$3)',[refCode,username,platform||'Unknown']);
    await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,stripe_session_id,ref_code,referred_by) VALUES ($1,$2,$3,$4,$5,true,'Stripe',$6,$7,$8)`,[comp.id,username,platform||'Unknown',game,tickets,sessionId,ref,referred_by||null]);
    if(game==='darts'&&dart_score)await pool.query('INSERT INTO darts_leaderboard (competition_id,username,platform,score,tickets,ref_code) VALUES ($1,$2,$3,$4,$5,$6)',[comp.id,username,platform||'Unknown',parseInt(dart_score),tickets,ref]);
    if(referred_by){
      const referrer=await pool.query('SELECT * FROM referrals WHERE referral_code=$1',[referred_by]);
      if(referrer.rows.length){
        await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code) VALUES ($1,$2,$3,'referral_bonus',3,true,'Referral',$4)`,[comp.id,referrer.rows[0].username,referrer.rows[0].platform,generateRef('RB')]);
        await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code) VALUES ($1,$2,$3,'referral_bonus',3,true,'Referral',$4)`,[comp.id,username,platform||'Unknown',generateRef('RB')]);
        await pool.query('UPDATE referrals SET bonus_tickets=bonus_tickets+3,friends_referred=friends_referred+1 WHERE referral_code=$1',[referred_by]);
      }
    }
    res.json({success:true,refCode:ref,tickets,referralCode:refCode});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PAYPAL WEBHOOK ───────────────────────────────────
app.post('/api/webhook/paypal',async(req,res)=>{
  try{
    const body=req.body;
    const paymentStr=JSON.stringify(body);
    const refMatch=paymentStr.match(/[A-Z]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    if(refMatch)await pool.query('UPDATE entries SET paid=true,payment_method=$1 WHERE ref_code=$2',['PayPal',refMatch[0]]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: GET ALL ENTRIES ────────────────────────────
app.get('/api/host/entries',checkHost,async(req,res)=>{
  try{
    const c=await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.json({entries:[]});
    const e=await pool.query('SELECT * FROM entries WHERE competition_id=$1 ORDER BY created_at DESC',[c.rows[0].id]);
    const lb=await pool.query('SELECT * FROM darts_leaderboard WHERE competition_id=$1 ORDER BY score DESC LIMIT 10',[c.rows[0].id]);
    const withdrawals=await pool.query("SELECT wr.*,p.wallet_balance FROM withdrawal_requests wr JOIN players p ON wr.player_id=p.id WHERE wr.status='pending' ORDER BY wr.created_at ASC");
    const players=await pool.query('SELECT id,username,platform,wallet_balance,total_deposited,total_withdrawn,total_won,created_at FROM players ORDER BY created_at DESC LIMIT 50');
    res.json({competition:c.rows[0],entries:e.rows,leaderboard:lb.rows,pendingWithdrawals:withdrawals.rows,players:players.rows});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: MARK PAID ──────────────────────────────────
app.post('/api/host/mark-paid',checkHost,async(req,res)=>{
  try{
    const{refCode,paid,paymentMethod}=req.body;
    await pool.query('UPDATE entries SET paid=$1,payment_method=$2 WHERE ref_code=$3',[paid,paymentMethod||'Manual',refCode]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: PROCESS WITHDRAWAL ─────────────────────────
app.post('/api/host/process-withdrawal',checkHost,async(req,res)=>{
  try{
    const{withdrawalId,action}=req.body;
    const wr=await pool.query('SELECT * FROM withdrawal_requests WHERE id=$1',[withdrawalId]);
    if(!wr.rows.length)return res.status(404).json({error:'Not found'});
    const w=wr.rows[0];
    if(action==='approve'){
      await pool.query('UPDATE withdrawal_requests SET status=$1,processed_at=NOW() WHERE id=$2',['completed',withdrawalId]);
      await pool.query('UPDATE players SET total_withdrawn=total_withdrawn+$1 WHERE id=$2',[w.amount,w.player_id]);
      await pool.query(`UPDATE wallet_transactions SET status='completed' WHERE player_id=$1 AND type='withdrawal' AND status='pending' ORDER BY created_at DESC LIMIT 1`,[w.player_id]);
    } else {
      // Refund to wallet
      await pool.query('UPDATE withdrawal_requests SET status=$1,processed_at=NOW() WHERE id=$2',['rejected',withdrawalId]);
      await pool.query('UPDATE players SET wallet_balance=wallet_balance+$1 WHERE id=$2',[w.amount,w.player_id]);
      await pool.query(`INSERT INTO wallet_transactions (player_id,type,amount,description) VALUES ($1,'refund',$2,'Withdrawal rejected — funds returned')`,[w.player_id,w.amount]);
    }
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: DRAW WINNER ────────────────────────────────
app.post('/api/host/draw-winner',checkHost,async(req,res)=>{
  try{
    const c=await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    const comp=c.rows[0];
    const entries=await pool.query(`SELECT * FROM entries WHERE competition_id=$1 AND paid=true AND game!='referral_bonus'`,[comp.id]);
    if(!entries.rows.length)return res.status(400).json({error:'No paid entries'});
    const weighted=[];
    for(const e of entries.rows)for(let i=0;i<e.qty;i++)weighted.push(e);
    const winner=weighted[Math.floor(Math.random()*weighted.length)];
    const potEntries=entries.rows.filter(e=>e.game==='pot');
    const totalPot=potEntries.reduce((s,e)=>s+e.qty,0)*1.00;
    const prize=(totalPot*(1-HOST_CUT/100)).toFixed(2);
    const cut=(totalPot*(HOST_CUT/100)).toFixed(2);
    await pool.query('UPDATE competitions SET winner_drawn=true,winner_name=$1,pot_revealed=true WHERE id=$2',[winner.username,comp.id]);
    // Credit wallet if player has account
    if(winner.player_id&&parseFloat(prize)>0)await creditWinToWallet(winner.player_id,parseFloat(prize),'Saturday draw winner!');
    // Darts top 3 bonus
    const lb=await pool.query('SELECT username,platform,player_id FROM darts_leaderboard WHERE competition_id=$1 ORDER BY score DESC LIMIT 3',[comp.id]);
    for(const d of lb.rows)await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code) VALUES ($1,$2,$3,'darts_bonus',10,true,'Darts LB',$4)`,[comp.id,d.username,d.platform,generateRef('DB')]);
    res.json({success:true,winner:winner.username,refCode:winner.ref_code,platform:winner.platform,totalEntries:weighted.length,prizePot:prize,hostCut:cut});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: NEW COMPETITION ────────────────────────────
app.post('/api/host/new-competition',checkHost,async(req,res)=>{
  try{
    const{name}=req.body;
    const d=new Date();
    const days=(6-d.getDay()+7)%7||7;
    d.setDate(d.getDate()+days);d.setHours(20,0,0,0);
    await pool.query('UPDATE competitions SET live=false');
    await pool.query('INSERT INTO competitions (name,end_date,price,host_cut,live) VALUES ($1,$2,1.00,30,true)',[name||'Mystery Pot Challenge',d]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HOST: STATS ──────────────────────────────────────
app.get('/api/host/stats',checkHost,async(req,res)=>{
  try{
    const c=await pool.query('SELECT * FROM competitions ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.json({});
    const stats=await pool.query(`SELECT game,COUNT(*) as plays,SUM(qty) as tickets FROM entries WHERE competition_id=$1 GROUP BY game`,[c.rows[0].id]);
    const totalPlayers=await pool.query('SELECT COUNT(*) as total FROM players');
    const totalBalance=await pool.query('SELECT SUM(wallet_balance) as total FROM players');
    res.json({competition:c.rows[0],gameStats:stats.rows,totalPlayers:totalPlayers.rows[0].total,totalWalletBalance:totalBalance.rows[0].total});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── ADMIN: TESTER ────────────────────────────────────
app.post('/api/admin/test-entry',checkHost,async(req,res)=>{
  try{
    const{game,username,platform,dart_score,hangman_solved,qualified}=req.body;
    const c=await pool.query('SELECT * FROM competitions WHERE live=true ORDER BY id DESC LIMIT 1');
    if(!c.rows.length)return res.status(400).json({error:'No active competition'});
    const comp=c.rows[0];
    let tickets=TICKETS[game]||5;
    if(game==='hangman')tickets=hangman_solved?TICKETS.hangman_solve:TICKETS.hangman_fail;
    if(game==='darts'&&dart_score)tickets=getDartsTickets(parseInt(dart_score));
    if(game==='hl')tickets=qualified?TICKETS.hl_qualify+TICKETS.hl_attempt:TICKETS.hl_attempt;
    const prefixes={pot:'MP',spin:'MS',scratch:'SC',hangman:'HW',hl:'HL',darts:'DT'};
    const ref=generateRef((prefixes[game]||'MP')+'T');
    await pool.query(`INSERT INTO entries (competition_id,username,platform,game,qty,paid,payment_method,ref_code) VALUES ($1,$2,$3,$4,$5,true,'TEST',$6)`,[comp.id,username||'TestPlayer',platform||'TikTok',game,tickets,ref]);
    if(game==='darts'&&dart_score)await pool.query('INSERT INTO darts_leaderboard (competition_id,username,platform,score,tickets,ref_code) VALUES ($1,$2,$3,$4,$5,$6)',[comp.id,username||'TestPlayer',platform||'TikTok',parseInt(dart_score),tickets,ref]);
    res.json({success:true,refCode:ref,tickets,message:`✅ TEST entry: ${ref} · ${tickets} tickets`});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── HEALTH ───────────────────────────────────────────
app.get('/health',(req,res)=>res.json({status:'ok',time:new Date()}));

const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  console.log('Mystery Pot server running on port '+PORT);
  await initDB();
});
