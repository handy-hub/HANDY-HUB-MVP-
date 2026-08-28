import { PlatformSettings } from '../types';

export const DEFAULT_SETTINGS: PlatformSettings = {
  general: {
    maintenance_mode: false,
    app_availability: 'public',
    default_language: 'en',
    timezone: 'UTC',
    support_email: 'support@artisanplatform.com',
    support_phone: '+1234567890',
  },
  users: {
    allow_registration: true,
    require_email_verification: true,
    allow_social_login: true,
    default_search_radius_km: 25,
    enable_referral_system: true,
    referral_bonus_amount: 20,
    max_failed_login_attempts: 5,
    account_deletion_grace_period_days: 30,
  },
  artisans: {
    allow_new_registrations: true,
    require_verification: true,
    max_active_jobs: 3,
    broadcast_radius_km: 50,
    commission_rate: 15,
    enable_wallet: true,
    categories: [
      { id: 'plumbing', name: 'Plumbing', icon: '🛠️', active: true, base_price: 50 },
      { id: 'electrical', name: 'Electrical', icon: '⚡', active: true, base_price: 60 },
      { id: 'cleaning', name: 'Cleaning', icon: '🧹', active: true, base_price: 40 }
    ]
  },
  marketplace: {
    auto_cancel_minutes: 30,
    buffer_time_between_jobs_minutes: 15,
    artisan_acceptance_timeout_minutes: 5,
    auto_reassign_on_timeout: true,
    featured_listing_price: 100,
  },
  financials: {
    currency: 'GHS',
    currency_symbol: 'GH₵',
    global_commission_rate: 10,
    call_out_fee: 50,
    min_job_value: 10,
    min_withdrawal_amount: 10,
  },
  security: {
    two_factor_authentication: false,
    password_complexity_requirement: 'medium',
    ip_whitelist_enabled: false,
    admin_session_timeout: 30,
    max_login_attempts: 5,
    force_update: false,
    roles: [
      { id: 'role-1', name: 'Super Admin', permissions: ['all'] },
      { id: 'role-2', name: 'Operations Admin', permissions: ['artisans', 'jobs', 'customers', 'disputes', 'regions'] },
      { id: 'role-3', name: 'Finance Admin', permissions: ['payments', 'commission', 'payouts'] }
    ]
  },
  communications: {
    email_notifications: true,
    push_notifications: true,
    sms_notifications: false,
    admin_alerts: true,
    enable_chat: true,
  },
  audit: {
    retention_days: 90,
    log_level: 'info',
    export_format: 'json',
    notify_on_critical_errors: true,
    audit_log_storage_limit_gb: 5,
  },
  api: {
    base_url: 'https://api.artisanplatform.com/v1',
    rate_limit_per_minute: 1000,
    api_key_rotation_days: 30,
    enable_webhooks: true,
    webhook_url: 'https://hooks.artisanplatform.com',
    documentation_url: 'https://docs.artisanplatform.com',
    support_email: 'api-support@artisanplatform.com',
    timeout_ms: 30000,
  },
  advanced: {
    environment: 'production',
    node_version: '18.x',
    cluster_mode: true,
    backup_frequency: 'daily',
    debug_mode: false,
    maintenance_message: 'System is currently undergoing maintenance. Please try again later.',
    log_level: 'info',
  },
};
