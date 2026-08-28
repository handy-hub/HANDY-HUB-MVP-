import { useEffect, useCallback, useState, useRef } from 'react';
import { auth, db } from '../firebase';
import { signOut, onAuthStateChanged, User } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';

const DEFAULT_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const WARNING_THRESHOLD = 2 * 60 * 1000; // 2 minutes

export function useSessionTimeout() {
  const navigate = useNavigate();
  const [showWarning, setShowWarning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [timeoutDuration, setTimeoutDuration] = useState(DEFAULT_TIMEOUT);
  const [user, setUser] = useState<User | null>(auth.currentUser);
  
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const warningIdRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIdRef = useRef<NodeJS.Timeout | null>(null);

  // Track auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsub();
  }, []);

  // Fetch timeout from settings
  useEffect(() => {
    if (!user) return;

    const unsub = onSnapshot(doc(db, 'settings', 'platform'), (doc) => {
      if (doc.exists()) {
        const data = doc.data();
        if (data.security?.session_timeout_minutes) {
          setTimeoutDuration(data.security.session_timeout_minutes * 60 * 1000);
        }
      }
    }, (error) => {
      console.warn("Failed to fetch session timeout settings:", error.message);
    });
    return () => unsub();
  }, [user]);

  const handleLogout = useCallback(async () => {
    try {
      await signOut(auth);
      setShowWarning(false);
      navigate('/login', { state: { error: 'Session expired due to inactivity.' } });
    } catch (error) {
      console.error('Logout failed during session timeout:', error);
    }
  }, [navigate]);

  const resetTimer = useCallback(() => {
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    if (warningIdRef.current) clearTimeout(warningIdRef.current);
    if (countdownIdRef.current) clearTimeout(countdownIdRef.current);
    
    setShowWarning(false);
    
    // Set main timeout
    timeoutIdRef.current = setTimeout(handleLogout, timeoutDuration);
    
    // Set warning timeout
    warningIdRef.current = setTimeout(() => {
      setShowWarning(true);
      setRemainingSeconds(Math.floor(WARNING_THRESHOLD / 1000));
    }, timeoutDuration - WARNING_THRESHOLD);
  }, [handleLogout, timeoutDuration]);

  // Countdown timer when warning is shown
  useEffect(() => {
    if (showWarning && remainingSeconds > 0) {
      countdownIdRef.current = setTimeout(() => {
        setRemainingSeconds(prev => prev - 1);
      }, 1000);
    }
    return () => {
      if (countdownIdRef.current) clearTimeout(countdownIdRef.current);
    };
  }, [showWarning, remainingSeconds]);

  useEffect(() => {
    const events = [
      'mousedown',
      'mousemove',
      'keypress',
      'scroll',
      'touchstart',
      'click'
    ];

    const handleActivity = () => {
      if (!showWarning) {
        resetTimer();
      }
    };

    // Initial timer
    resetTimer();

    // Add event listeners
    events.forEach(event => {
      window.addEventListener(event, handleActivity);
    });

    return () => {
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      if (warningIdRef.current) clearTimeout(warningIdRef.current);
      if (countdownIdRef.current) clearTimeout(countdownIdRef.current);
      
      events.forEach(event => {
        window.removeEventListener(event, handleActivity);
      });
    };
  }, [resetTimer, showWarning]);

  return {
    showWarning,
    remainingSeconds,
    extendSession: resetTimer,
    logout: handleLogout
  };
}
