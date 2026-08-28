import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { Resend } from 'resend';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

// Load Firebase configuration
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: '13446084861' // Using the project number from the error message
  });
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // Mock API Routes
  const apiRouter = express.Router();

  apiRouter.get("/stats", (req, res) => {
    res.json({
      jobs_today: 143,
      active_jobs: 28,
      pending_approvals: 7,
      escrow_balance: 14820,
      revenue_today: 2340,
      open_disputes: 3,
      growth: {
        jobs: "+12%",
        active: "+4",
        approvals: "SLA!",
        revenue: "+18%"
      }
    });
  });

  apiRouter.get("/artisans", (req, res) => {
    res.json([
      { id: 'A001', name: 'Kwame Asante', category: 'Electrical', rating: 4.8, jobs: 156, status: 'active', earnings: 12400, joined: '2024-01-15', avatar: 'KA', color: 'blue' },
      { id: 'A002', name: 'Ama Boateng', category: 'Plumbing', rating: 4.9, jobs: 203, status: 'active', earnings: 18600, joined: '2023-12-10', avatar: 'AB', color: 'green' },
      { id: 'A003', name: 'Kojo Mensah', category: 'AC Repair', rating: 4.6, jobs: 89, status: 'active', earnings: 9200, joined: '2024-03-01', avatar: 'KM', color: 'teal' },
      { id: 'A004', name: 'Abena Ofori', category: 'Carpentry', rating: 4.7, jobs: 74, status: 'pending', earnings: 0, joined: '2024-03-14', avatar: 'AO', color: 'orange' },
      { id: 'A005', name: 'Fiifi Acheampong', category: 'Painting', rating: 4.5, jobs: 112, status: 'active', earnings: 7800, joined: '2024-02-20', avatar: 'FA', color: 'purple' },
      { id: 'A006', name: 'Yaa Darko', category: 'Cleaning', rating: 4.3, jobs: 67, status: 'pending', earnings: 0, joined: '2024-03-15', avatar: 'YD', color: 'blue' },
      { id: 'A007', name: 'Kofi Asare', category: 'Mechanic', rating: 4.1, jobs: 45, status: 'suspended', earnings: 3100, joined: '2024-06-05', avatar: 'KA', color: 'orange' },
    ]);
  });

  apiRouter.get("/jobs", (req, res) => {
    res.json([
      { id: 'JB-1041', category: 'Electrical', customerId: 'C001', artisanId: 'A001', amount: 320, status: 'In Progress', time: '2h 15m ago', elapsed: '2h 15m' },
      { id: 'JB-1040', category: 'Plumbing', customerId: 'C002', artisanId: 'A002', amount: 180, status: 'Awaiting Confirmation', time: '3h 40m ago', elapsed: '3h 40m' },
      { id: 'JB-1039', category: 'AC Repair', customerId: 'C003', artisanId: 'A003', amount: 450, status: 'Completed', time: '5h ago', elapsed: '—' },
      { id: 'JB-1038', category: 'Carpentry', customerId: 'C004', artisanId: null, amount: 0, status: 'Pending', time: '12m ago', elapsed: '12m' },
      { id: 'JB-1037', category: 'Cleaning', customerId: 'C005', artisanId: 'A006', amount: 120, status: 'En Route', time: '45m ago', elapsed: '45m' },
      { id: 'JB-1036', category: 'Painting', customerId: 'C001', artisanId: 'A005', amount: 650, status: 'Completed', time: '8h ago', elapsed: '—' },
    ]);
  });

  apiRouter.get("/alerts", (req, res) => {
    res.json([
      { id: 1, type: 'red', title: 'Long Job Alert', desc: 'JB-1041 — Electrical job running 2.2x expected time', time: '5m ago' },
      { id: 2, type: 'gold', title: '7 Artisans Awaiting Approval', desc: 'Oldest application: 38 hours. SLA at risk.', time: '1h ago' },
      { id: 3, type: 'red', title: 'Dispute Opened', desc: 'JB-1020 — Quality Issue — GHS 380 in escrow', time: '2h ago' },
      { id: 4, type: 'green', title: 'Payout Successful', desc: 'GHS 1,240 released to 8 artisans via MoMo', time: '3h ago' },
      { id: 5, type: 'blue', title: 'Auto-Release Due', desc: 'JB-1037 — 48hr window expires in 1h 20m', time: '4h ago' },
    ]);
  });

  apiRouter.get("/customers", (req, res) => {
    res.json([
      { id: 'C001', name: 'Mawuli Doe', phone: '+233 24 111 2233', location: 'East Legon', bookings: 12, spent: 4200, status: 'active', joined: '2024-01-05' },
      { id: 'C002', name: 'Efua Mensah', phone: '+233 20 444 5566', location: 'Osu', bookings: 8, spent: 2800, status: 'active', joined: '2024-03-10' },
      { id: 'C003', name: 'Nana Kofi', phone: '+233 27 777 8899', location: 'Airport', bookings: 23, spent: 9100, status: 'active', joined: '2023-11-20' },
      { id: 'C004', name: 'Esi Amoah', phone: '+233 24 222 3344', location: 'Tema', bookings: 3, spent: 450, status: 'active', joined: '2024-06-01' },
      { id: 'C005', name: 'Kwesi Boateng', phone: '+233 50 666 7788', location: 'Labone', bookings: 15, spent: 5600, status: 'active', joined: '2024-02-15' },
    ]);
  });

  apiRouter.get("/disputes", (req, res) => {
    res.json([
      { id: 'D-031', jobId: 'JB-1020', customerId: 'C001', artisanId: 'A006', amount: 380, reason: 'Quality Issue', days: 2, status: 'open' },
      { id: 'D-030', jobId: 'JB-1015', customerId: 'C002', artisanId: 'A004', amount: 220, reason: 'Overcharging', days: 1, status: 'open' },
      { id: 'D-029', jobId: 'JB-1009', customerId: 'C003', artisanId: 'A003', amount: 510, reason: 'Incomplete Work', days: 4, status: 'open' },
    ]);
  });

  let admins = [
    { id: 'ADM-001', name: 'Silas Kwesi', role: 'Super Admin', email: 'silas@handyhub.com', lastLogin: 'Now', status: 'active' },
    { id: 'ADM-002', name: 'Kojo Mensah', role: 'Operations Admin', email: 'kojo@handyhub.com', lastLogin: '2h ago', status: 'active' },
    { id: 'ADM-003', name: 'Ama Boateng', role: 'Finance Admin', email: 'ama@handyhub.com', lastLogin: 'Yesterday', status: 'active' },
  ];

  let auditLogs = [
    { id: 'LOG-001', adminId: 'ADM-001', adminName: 'Silas Kwesi', action: 'Update Settings', target: 'Commission Rate', details: 'Changed from 15% to 20%', timestamp: '2026-03-17T02:30:00Z', ip: '192.168.1.1' },
    { id: 'LOG-002', adminId: 'ADM-002', adminName: 'Kojo Mensah', action: 'Approve Artisan', target: 'Kwame Asante', details: 'Approved application for Electrical category', timestamp: '2026-03-17T01:15:00Z', ip: '192.168.1.5' },
    { id: 'LOG-003', adminId: 'ADM-001', adminName: 'Silas Kwesi', action: 'Change Role', target: 'Ama Boateng', details: 'Promoted to Finance Admin', timestamp: '2026-03-16T18:45:00Z', ip: '192.168.1.1' },
    { id: 'LOG-004', adminId: 'ADM-003', adminName: 'Ama Boateng', action: 'Process Payout', target: 'Batch #452', details: 'Released GHS 1,240 to 8 artisans', timestamp: '2026-03-16T15:20:00Z', ip: '192.168.1.12' },
  ];

  apiRouter.get("/admins", (req, res) => {
    res.json(admins);
  });

  apiRouter.put("/admins/:id", (req, res) => {
    const { id } = req.params;
    const adminIndex = admins.findIndex(a => a.id === id);
    if (adminIndex !== -1) {
      admins[adminIndex] = { ...admins[adminIndex], ...req.body };
      res.json(admins[adminIndex]);
    } else {
      res.status(404).json({ error: "Admin not found" });
    }
  });

  apiRouter.get("/audits", (req, res) => {
    const { adminId } = req.query;
    if (adminId) {
      res.json(auditLogs.filter(log => log.adminId === adminId));
    } else {
      res.json(auditLogs);
    }
  });

  apiRouter.post("/send-otp", async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required" });
    }

    if (!resend) {
      console.warn("RESEND_API_KEY not configured. OTP will not be sent via email.");
      return res.json({ success: true, debug: true, message: "OTP logged to console (RESEND_API_KEY missing)" });
    }

    try {
      const { data, error } = await resend.emails.send({
        from: 'HandyHub <onboarding@resend.dev>',
        to: email,
        subject: 'Your HandyHub Verification Code',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #3b82f6;">Verification Code</h2>
            <p>Your verification code for HandyHub Admin is:</p>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; border-radius: 5px;">
              ${code}
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">
              This code will expire in 10 minutes. If you didn't request this code, please ignore this email.
            </p>
          </div>
        `
      });

      if (error) {
        console.error("Resend OTP Error Detail:", JSON.stringify(error, null, 2));
        
        let message = "Failed to send verification code. Please check if your Resend account allows sending to this email.";
        if (error.name === 'validation_error') {
          message = "Resend API Validation Error: This usually happens if the recipient email is not verified in your Resend dashboard (for trial accounts) or the 'from' address is incorrect.";
        }

        return res.status(200).json({ 
          success: false, 
          error: error.name || "Resend API Error", 
          details: error,
          message: message
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to send email:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  let platformSettings = {
    commission_rate: 20,
    auto_release_hours: 48,
    call_out_fee: 20,
    maintenance_mode: false,
    categories: [
      { id: 1, name: 'Electrical', commission: 20, active: true },
      { id: 2, name: 'Plumbing', commission: 20, active: true },
      { id: 3, name: 'AC Repair', commission: 20, active: true },
      { id: 4, name: 'Carpentry', commission: 15, active: true },
      { id: 5, name: 'Cleaning', commission: 10, active: true },
    ],
    payment_methods: {
      momo: true,
      card: true,
      bank: false,
    },
    regions: [
      'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 
      'Greater Accra', 'Northern', 'North East', 'Oti', 'Savannah', 
      'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'
    ],
    regional_data: {
      'Ahafo': { artisans: 45, active_jobs: 12, revenue: 3400, growth: '+5%' },
      'Ashanti': { artisans: 850, active_jobs: 124, revenue: 45000, growth: '+12%' },
      'Bono': { artisans: 120, active_jobs: 28, revenue: 8900, growth: '+8%' },
      'Bono East': { artisans: 95, active_jobs: 18, revenue: 6200, growth: '+4%' },
      'Central': { artisans: 340, active_jobs: 56, revenue: 18500, growth: '+10%' },
      'Eastern': { artisans: 420, active_jobs: 72, revenue: 22000, growth: '+9%' },
      'Greater Accra': { artisans: 1250, active_jobs: 215, revenue: 85000, growth: '+15%' },
      'Northern': { artisans: 210, active_jobs: 34, revenue: 11200, growth: '+6%' },
      'North East': { artisans: 35, active_jobs: 8, revenue: 2100, growth: '+2%' },
      'Oti': { artisans: 55, active_jobs: 14, revenue: 3800, growth: '+5%' },
      'Savannah': { artisans: 40, active_jobs: 10, revenue: 2900, growth: '+3%' },
      'Upper East': { artisans: 85, active_jobs: 16, revenue: 5400, growth: '+4%' },
      'Upper West': { artisans: 70, active_jobs: 12, revenue: 4800, growth: '+3%' },
      'Volta': { artisans: 280, active_jobs: 48, revenue: 14500, growth: '+7%' },
      'Western': { artisans: 480, active_jobs: 84, revenue: 32000, growth: '+11%' },
      'Western North': { artisans: 65, active_jobs: 15, revenue: 4200, growth: '+4%' }
    },
    notifications: {
      email: true,
      sms: true,
      push: true,
      templates: [
        { id: '1', name: 'Welcome Email', subject: 'Welcome to Handy Hub', content: 'Hello {{name}}, welcome!', enabled: true },
        { id: '2', name: 'Job Confirmation', subject: 'Job Confirmed', content: 'Your job {{jobId}} is confirmed.', enabled: true },
        { id: '3', name: 'Payment Received', subject: 'Payment Success', content: 'We received your payment.', enabled: true },
        { id: '4', name: 'Dispute Opened', subject: 'Dispute Alert', content: 'A dispute has been opened.', enabled: true },
      ]
    },
    job_rules: {
      min_job_amount: 50,
      max_active_jobs_per_artisan: 3,
      cancellation_fee: 15,
      require_photos: true,
      auto_cancel_minutes: 15,
      min_rating: 4.2,
      dispute_auto_resolve_days: 7
    },
    security: {
      two_factor: false,
      session_timeout: 60,
      require_strong_password: true,
      gateway: {
        public_key: 'pk_test_xxxxxxxxxxxxxxxxxxxxxxxx',
        secret_key: 'sk_test_xxxxxxxxxxxxxxxxxxxxxxxx'
      },
      admin_roles: [
        { name: 'Super Admin', permissions: ['all'] },
        { name: 'Operations Admin', permissions: ['jobs', 'artisans', 'customers'] },
        { name: 'Finance Admin', permissions: ['payments', 'commission', 'payouts'] },
        { name: 'Support Admin', permissions: ['disputes', 'customers', 'notifications'] }
      ]
    },
    promotional_rates: [
      { id: '1', name: 'Easter Special', rate: 10, start_date: '2026-04-01', end_date: '2026-04-10', active: true }
    ],
    maintenance: {
      auto_backups: true,
      backup_frequency: 'daily',
      last_backup: '2026-03-16T02:00:00Z',
      log_retention_days: 30
    }
  };

  apiRouter.get("/settings", (req, res) => {
    res.json(platformSettings);
  });

  apiRouter.put("/settings", (req, res) => {
    platformSettings = { ...platformSettings, ...req.body };
    res.json(platformSettings);
  });

  app.use("/api", apiRouter);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
