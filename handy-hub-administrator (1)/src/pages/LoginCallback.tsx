import React, { useEffect, useState } from 'react';
import { isSignInWithEmailLink, signInWithEmailLink } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { AlertTriangle, Loader2 } from 'lucide-react';

export function LoginCallback() {
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const completeSignIn = async () => {
      if (isSignInWithEmailLink(auth, window.location.href)) {
        let email = window.localStorage.getItem('emailForSignIn');
        if (!email) {
          // User opened the link on a different device. To prevent session fixation
          // attacks, ask the user to provide the associated email again. For simplicity,
          // we'll just show an error here.
          setError('Please open the link on the same device you requested it from, or provide your email.');
          return;
        }

        try {
          await signInWithEmailLink(auth, email, window.location.href);
          window.localStorage.removeItem('emailForSignIn');
          navigate('/');
        } catch (err: any) {
          console.error('Email link sign in error:', err);
          setError('Failed to complete sign in. The link may have expired.');
        }
      } else {
        navigate('/login');
      }
    };

    completeSignIn();
  }, [navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-bg-dark flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-bg-panel rounded-3xl shadow-2xl p-8 text-center border border-white/10">
          <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center text-red-500 mx-auto mb-6">
            <AlertTriangle size={32} />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Authentication Error</h2>
          <p className="text-white/40 mb-8">{error}</p>
          <button 
            onClick={() => navigate('/login')}
            className="w-full py-3 bg-accent-blue text-white rounded-xl font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-dark flex items-center justify-center p-4">
      <div className="text-center">
        <Loader2 className="w-12 h-12 text-accent-blue animate-spin mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white">Completing Sign In...</h2>
        <p className="text-white/40">Please wait while we verify your identity.</p>
      </div>
    </div>
  );
}
