const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const path = require('path');

dotenv.config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ATSFix is alive!', timestamp: new Date() });
});

// ATS Scanner endpoint
app.post('/api/scan', async (req, res) => {
  try {
    const { resume, jobDescription } = req.body;

    if (!resume || !jobDescription) {
      return res.status(400).json({ error: 'Resume and job description are required' });
    }

    const prompt = `You are an expert ATS (Applicant Tracking System) analyzer. 

Analyze this resume against the job description and provide:
1. ATS Score (0-100)
2. Missing keywords (list the top 10)
3. Found keywords (list what matches)
4. Specific improvements needed
5. Rewritten professional summary optimized for this job

Resume:
${resume}

Job Description:
${jobDescription}

Respond in this exact JSON format:
{
  "score": 72,
  "missing_keywords": ["keyword1", "keyword2"],
  "found_keywords": ["keyword1", "keyword2"],
  "improvements": ["improvement1", "improvement2"],
  "rewritten_summary": "Your optimized summary here..."
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(completion.choices[0].message.content);
    res.json(result);

  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
});

// Stripe checkout
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { email } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: 'https://atsfix.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://atsfix.app',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Checkout failed. Please try again.' });
  }
});

// Stripe webhook
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;

    // Add user to Supabase
    await supabase.from('users').upsert({ 
      email, 
      is_pro: true, 
      created_at: new Date() 
    });

    // Send welcome email
    await resend.emails.send({
      from: 'ATSFix <hello@atsfix.app>',
      to: email,
      subject: 'Welcome to ATSFix Pro! 🎉',
      html: `
        <h1>You're in! Welcome to ATSFix Pro</h1>
        <p>Your account is now active. Start beating the bots!</p>
        <a href="https://atsfix.app" style="background:#6366f1;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;">
          Start Scanning →
        </a>
      `
    });
  }

  res.json({ received: true });
});

// Check pro status
app.post('/api/check-pro', async (req, res) => {
  try {
    const { email } = req.body;
    const { data } = await supabase
      .from('users')
      .select('is_pro')
      .eq('email', email)
      .single();
    
    res.json({ isPro: data?.is_pro || false });
  } catch (error) {
    res.json({ isPro: false });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`ATSFix server running on port ${PORT}`);
  });
}

module.exports = app;

