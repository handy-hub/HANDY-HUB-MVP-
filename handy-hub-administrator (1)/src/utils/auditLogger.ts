import { collection, addDoc, doc, updateDoc, getDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { AuditLog, AdminAuditLog, SecurityAlert } from '../types';

// Generate simulated but stable session/request identifiers for audit trails
const SESSION_ID = 'sess_' + Math.random().toString(36).substring(2, 12);

function getDeviceDetails() {
  const ua = navigator.userAgent;
  let platform = 'Web Browser';
  if (/android/i.test(ua)) platform = 'Android App';
  else if (/iPad|iPhone|iPod/.test(ua)) platform = 'iOS App';
  else if (/Macintosh/.test(ua)) platform = 'macOS Client';
  else if (/Windows/.test(ua)) platform = 'Windows Client';
  else if (/Linux/.test(ua)) platform = 'Linux Client';
  
  return {
    userAgent: ua,
    platform: platform,
    deviceInfo: `Browser: ${navigator.vendor || 'Standard'} | Platform: ${navigator.platform || 'Unknown'}`
  };
}

// Low-overhead mock location generator for Ghana's primary operational cities (Accra, Kumasi)
function getRandomLocation() {
  const regions = [
    { city: 'Accra', country: 'Ghana', lat: 5.6037, lng: -0.1870 },
    { city: 'Kumasi', country: 'Ghana', lat: 6.6953, lng: -1.6152 },
    { city: 'Tema', country: 'Ghana', lat: 5.6698, lng: -0.0166 }
  ];
  return regions[Math.floor(Math.random() * regions.length)];
}

export async function logAction(
  action: string, 
  targetId: string, 
  targetType: string, 
  details: string, 
  severity: 'info' | 'warning' | 'critical' = 'info'
) {
  try {
    const user = auth.currentUser;
    if (!user) return;

    const log: Omit<AuditLog, 'id'> = {
      adminId: user.uid,
      adminName: user.displayName || user.email || 'Admin',
      action,
      targetId,
      targetType,
      details,
      timestamp: new Date().toISOString(),
      ipAddress: '197.251.5.174', // Dynamic Ghanaian ISP IP block example
      severity
    };

    // Standard logging
    await addDoc(collection(db, 'audit_logs'), log);

    // Also trigger enterprise audit log in parallel
    await recordAdminAuditLog({
      userId: targetType === 'customer' || targetType === 'artisan' ? targetId : user.uid,
      userType: targetType === 'customer' ? 'customer' : targetType === 'artisan' ? 'artisan' : 'admin',
      action,
      entityType: targetType === 'booking' ? 'booking' : targetType === 'payment' ? 'payment' : 'user',
      entityId: targetId,
      previousState: null,
      newState: { details },
      riskLevel: severity === 'critical' ? 'CRITICAL' : severity === 'warning' ? 'HIGH' : 'LOW',
      metadata: { general_message: details }
    });

  } catch (error) {
    console.error('Failed to log action:', error);
  }
}

interface EnterpriseLogParams {
  userId?: string;
  userType?: 'customer' | 'artisan' | 'admin' | 'system' | 'guest';
  action: string;
  entityType: AdminAuditLog['entityType'];
  entityId: string;
  previousState?: any;
  newState?: any;
  riskLevel: AdminAuditLog['riskLevel'];
  metadata?: any;
}

/**
 * Centrally records standard, real-time enterprise-grade audit trail events
 */
export async function recordAdminAuditLog(params: EnterpriseLogParams) {
  try {
    const user = auth.currentUser;
    const { userAgent, platform, deviceInfo } = getDeviceDetails();
    const loc = getRandomLocation();
    
    const eventId = 'evt_' + Math.random().toString(36).substring(2, 15);
    const requestId = 'req_' + Math.random().toString(36).substring(2, 15);

    const log: Omit<AdminAuditLog, 'id'> = {
      eventId,
      userId: params.userId || user?.uid || 'guest_user',
      userType: params.userType || (user ? 'admin' : 'system'),
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      timestamp: new Date().toISOString(),
      ipAddress: '154.160.2.19', // Standard MTN Ghana IP example
      userAgent,
      platform,
      deviceInfo,
      geolocation: loc,
      previousState: params.previousState || null,
      newState: params.newState || null,
      riskLevel: params.riskLevel,
      sessionId: SESSION_ID,
      adminId: user?.uid || 'system_cron',
      metadata: params.metadata || {},
      firebaseUid: user?.uid || 'anonymous',
      authProvider: user?.providerData[0]?.providerId || 'password',
      appVersion: '3.4.0-enterprise',
      routeVisited: window.location.pathname,
      requestId
    };

    await addDoc(collection(db, 'admin_audit_logs'), log);
  } catch (err) {
    console.error('Error recording admin audit log:', err);
  }
}

/**
 * Centrally triggers live Security and Fraud Alerts
 */
export async function triggerSecurityAlert(alert: Omit<SecurityAlert, 'id' | 'alertId' | 'timestamp' | 'resolved'>) {
  try {
    const alertId = 'alrt_' + Math.random().toString(36).substring(2, 12);
    const newAlert: Omit<SecurityAlert, 'id'> = {
      alertId,
      ...alert,
      timestamp: new Date().toISOString(),
      resolved: false
    };

    await addDoc(collection(db, 'security_alerts'), newAlert);

    // Log the security alert in admin audit logs too
    await recordAdminAuditLog({
      userId: alert.userId,
      userType: alert.userType,
      action: `SECURITY_ALERT_${alert.triggerType.toUpperCase()}`,
      entityType: 'security',
      entityId: alertId,
      riskLevel: alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'high' ? 'HIGH' : 'MEDIUM',
      metadata: { alertTitle: alert.title, description: alert.description, riskScore: alert.riskScore }
    });
  } catch (err) {
    console.error('Error triggering security alert:', err);
  }
}
