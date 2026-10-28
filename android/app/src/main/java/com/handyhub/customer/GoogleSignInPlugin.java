package com.handyhub.customer;

import android.os.CancellationSignal;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Native Google sign-in for the WebView app.
 *
 * WHY: the web flow cannot work inside Capacitor's WebView. signInWithPopup has
 * no window to open (the WebView has no onCreateWindow), and the
 * signInWithRedirect fallback navigates to lamax-4fd82.firebaseapp.com, which
 * Capacitor's Bridge.launchIntent hands to the external browser — the Google
 * account is chosen there and the result never comes back to the app. Google
 * also refuses OAuth inside embedded WebViews (disallowed_useragent).
 *
 * So the account is chosen natively (Android Credential Manager, the current
 * Google Identity API) and only the resulting Google ID token crosses into the
 * page, where the existing Firebase JS SDK signs in with it
 * (signInWithCredential) — the same Firebase user, session and profile path as
 * on the web.
 *
 * The token audience is the project's WEB client (default_web_client_id,
 * generated from google-services.json), which is what Firebase Auth verifies.
 * Google additionally checks this app's package name + signing-certificate
 * SHA-1 against an Android OAuth client in the same project; without one the
 * call fails with a developer-configuration error, reported to JS as
 * code "not_configured".
 */
@CapacitorPlugin(name = "FxGoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    private final Executor executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void signIn(PluginCall call) {
        final String webClientId;
        try {
            webClientId = getContext().getString(R.string.default_web_client_id);
        } catch (Exception e) {
            call.reject("google-services.json has no web client for this app.", "not_configured");
            return;
        }

        // The explicit "Sign in with Google" flow: always shows the account
        // chooser (including "add account"), never silently picks one.
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(webClientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager manager = CredentialManager.create(getContext());

        manager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            executor,
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        try {
                            GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                            JSObject result = new JSObject();
                            result.put("idToken", google.getIdToken());
                            result.put("email", google.getId());
                            result.put("displayName", google.getDisplayName());
                            call.resolve(result);
                        } catch (Exception e) {
                            call.reject("Google returned an unreadable credential.", "failed", e);
                        }
                        return;
                    }
                    call.reject("Google returned an unexpected credential type.", "failed");
                }

                @Override
                public void onError(GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException) {
                        call.reject("Google sign-in was cancelled.", "cancelled");
                    } else if (e instanceof NoCredentialException) {
                        call.reject("No Google account is available on this device.", "no_account");
                    } else {
                        String message = String.valueOf(e.getMessage());
                        // "[28444] Developer console is not set up correctly" and
                        // the like: the Android OAuth client / SHA-1 is missing.
                        boolean config = message.contains("28444") || message.toLowerCase().contains("developer console")
                            || message.contains("10:") || message.toLowerCase().contains("not set up");
                        call.reject(message, config ? "not_configured" : "failed", e);
                    }
                }
            }
        );
    }
}
