export type Status = 'active' | 'pending' | 'suspended' | 'banned' | 'Completed' | 'In Progress' | 'En Route' | 'Awaiting Confirmation' | 'Pending' | 'open' | 'resolved' | 'dismissed' | 'Cancelled';

export type UserType = 'admin' | 'artisan' | 'customer';

export type AdminRole = 'super_admin' | 'operations_admin' | 'finance_admin' | 'support_admin';

export interface BaseUser {
  id: string;
  name: string;
  email: string;
  status: string;
  createdAt: string;
  userType: UserType;
}

export interface AdminUser extends BaseUser {
  userType: 'admin';
  role: AdminRole;
  phone?: string;
  photoURL?: string;
  inviteId?: string;
  lastLogin: string;
  updatedAt?: string;
  publicKey?: string; // ECDH Public Key (spki/jwk format or raw)
  encryptedPrivateKey?: string; // ECDH Private Key encrypted with user's chat passphrase
  encryptionSalt?: string; // Salt used for deriving the wrapping key
  preferences?: {
    emailNotifications: boolean;
    pushNotifications: boolean;
    compactView: boolean;
    language: string;
  };
}

export interface Artisan extends BaseUser {
  userType: 'artisan';
  phone: string;
  category: string;
  rating: number;
  jobs_completed: number;
  status: 'active' | 'pending' | 'suspended' | 'banned';
  earnings: number;
  joined: string;
  region: string;
  avatar: string;
  commission_override?: number;
  internal_notes?: string;
  bio?: string;
  address?: string;
  momo_number?: string;
  momo_name?: string;
  documents?: {
    id: string;
    type: 'ID' | 'Certificate' | 'Business License';
    url: string;
    status: 'pending' | 'verified' | 'rejected';
    uploadedAt: string;
  }[];
}

export interface Customer extends BaseUser {
  userType: 'customer';
  phone: string;
  location: string;
  bookings: number;
  spent: number;
  status: 'active' | 'suspended';
  joined: string;
}

export interface Job {
  id: string;
  category: string;
  customerId: string;
  artisanId: string | null;
  amount: number;
  status: 'Pending' | 'In Progress' | 'En Route' | 'Awaiting Confirmation' | 'Completed' | 'Cancelled';
  createdAt: string;
  updatedAt: string;
  region: string;
}

export interface Dispute {
  id: string;
  jobId: string;
  customerId: string;
  artisanId: string;
  amount: number;
  reason: string;
  description?: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution?: 'RELEASE' | 'REFUND';
  resolvedAt?: string;
  resolvedBy?: string;
  internalNotes?: string;
  evidence?: {
    type: 'image' | 'text' | 'document';
    url?: string;
    content?: string;
    timestamp: string;
    author: 'customer' | 'artisan' | 'system';
  }[];
  createdAt: string;
}

export interface AuditLog {
  id: string;
  adminId: string;
  adminName: string;
  action: string;
  targetId: string;
  targetType: string;
  details: string;
  timestamp: string;
  ipAddress: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface AdminAuditLog {
  id: string;
  eventId: string;
  userId: string;
  userType: 'customer' | 'artisan' | 'admin' | 'system' | 'guest';
  action: string;
  entityType: 'booking' | 'payment' | 'user' | 'artisan' | 'escrow' | 'payout' | 'dispute' | 'chat' | 'settings' | 'security' | 'session';
  entityId: string;
  timestamp: string;
  ipAddress: string;
  userAgent: string;
  platform: string;
  deviceInfo: string;
  geolocation: {
    lat?: number;
    lng?: number;
    city?: string;
    country?: string;
  } | string;
  previousState?: any;
  newState?: any;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sessionId: string;
  adminId: string;
  metadata: any;
  firebaseUid: string;
  authProvider: string;
  appVersion: string;
  routeVisited: string;
  requestId: string;
}

export interface SecurityAlert {
  id: string;
  alertId: string;
  userId: string;
  userType: 'customer' | 'artisan' | 'admin' | 'guest';
  title: string;
  description: string;
  triggerType: 'gps_spoofing' | 'multiple_failed_logins' | 'payment_abuse' | 'rapid_cancellations' | 'escrow_abuse' | 'duplicate_accounts' | 'terminal_exploit_attempt' | 'admin_escalation_attempt';
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  actionTaken?: string;
  ipAddress: string;
  deviceInfo: string;
  riskScore: number;
}

export interface Region {
  id: string;
  name: string;
  code: string;
  active: boolean;
  createdAt: string;
}

export interface PlatformSettings {
  general: {
    maintenance_mode: boolean;
    app_availability: 'public' | 'invite_only' | 'closed';
    default_language: string;
    timezone: string;
    support_email: string;
    support_phone: string;
  };
  users: {
    allow_registration: boolean;
    require_email_verification: boolean;
    allow_social_login: boolean;
    default_search_radius_km: number;
    enable_referral_system: boolean;
    referral_bonus_amount: number;
    max_failed_login_attempts: number;
    account_deletion_grace_period_days: number;
  };
  artisans: {
    allow_new_registrations: boolean;
    require_verification: boolean;
    max_active_jobs: number;
    broadcast_radius_km: number;
    commission_rate: number;
    enable_wallet: boolean;
    categories: {
      id: string;
      name: string;
      icon: string;
      active: boolean;
      base_price: number;
    }[];
  };
  marketplace: {
    auto_cancel_minutes: number;
    buffer_time_between_jobs_minutes: number;
    artisan_acceptance_timeout_minutes: number;
    auto_reassign_on_timeout: boolean;
    featured_listing_price: number;
  };
  financials: {
    currency: string;
    currency_symbol: string;
    global_commission_rate: number;
    call_out_fee: number;
    min_job_value: number;
    min_withdrawal_amount: number;
  };
  security: {
    two_factor_authentication: boolean;
    password_complexity_requirement: 'low' | 'medium' | 'high';
    ip_whitelist_enabled: boolean;
    admin_session_timeout: number;
    max_login_attempts: number;
    force_update: boolean;
    roles: {
      id: string;
      name: string;
      permissions: string[];
    }[];
  };
  communications: {
    email_notifications: boolean;
    push_notifications: boolean;
    sms_notifications: boolean;
    admin_alerts: boolean;
    enable_chat: boolean;
  };
  audit: {
    retention_days: number;
    log_level: 'info' | 'warn' | 'error' | 'debug';
    export_format: 'json' | 'csv' | 'pdf';
    notify_on_critical_errors: boolean;
    audit_log_storage_limit_gb: number;
  };
  api: {
    base_url: string;
    rate_limit_per_minute: number;
    api_key_rotation_days: number;
    enable_webhooks: boolean;
    webhook_url: string;
    documentation_url: string;
    support_email: string;
    timeout_ms: number;
  };
  advanced: {
    environment: 'production' | 'staging' | 'development';
    node_version: string;
    cluster_mode: boolean;
    backup_frequency: 'daily' | 'weekly' | 'hourly';
    debug_mode: boolean;
    maintenance_message: string;
    log_level: 'info' | 'warn' | 'error' | 'debug';
  };
}

export interface Payout {
  id: string;
  artisanId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'processed';
  method: 'momo' | 'bank';
  details: string;
  requestedAt: string;
  processedAt?: string;
  processedBy?: string;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
  createdAt: string;
  link?: string;
  category?: 'system' | 'job' | 'payment' | 'security' | 'message';
}

export interface AdminChat {
  id: string;
  participants: string[];
  lastMessage?: string;
  lastMessageAt?: string;
  updatedAt: string;
  nicknames?: { [userId: string]: string };
  activeCall?: {
    type: 'audio' | 'video';
    startedAt: string;
    startedBy: string;
    status: 'calling' | 'ongoing' | 'ended';
  };
}

export interface AdminMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string; // Will hold a preview or placeholder if isEncrypted is true
  ciphertext?: string; // Encrypted message content
  iv?: string; // Initialization vector for decryption
  timestamp: string;
  read: boolean;
  isEncrypted?: boolean;
}

export interface SupportChat {
  id: string; // Matches customer/artisan user UID
  userId: string;
  userName: string;
  userEmail: string;
  userType: 'customer' | 'artisan';
  lastMessage?: string;
  lastMessageAt?: string;
  status: 'open' | 'pending' | 'resolved';
  unreadByAdmin?: boolean;
  unreadByUser?: boolean;
  updatedAt: string;
}

export interface SupportMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  senderType: 'user' | 'support';
  text: string;
  timestamp: string;
  read: boolean;
}

