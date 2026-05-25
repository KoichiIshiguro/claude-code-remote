'use strict';

const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');

// Shared session middleware instance so WS upgrade handler can reuse it
let sessionMiddleware;
let passportMiddleware;
let passportSession;

function setupAuth(app) {
  const allowedUser = process.env.ALLOWED_GITHUB_USER;

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      'SESSION_SECRET is required. Generate one with: openssl rand -hex 32'
    );
  }
  if (!allowedUser) {
    console.warn('[auth] ALLOWED_GITHUB_USER is not set — any GitHub user can sign in');
  }

  sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });

  passportMiddleware = passport.initialize();
  passportSession = passport.session();

  app.use(sessionMiddleware);
  app.use(passportMiddleware);
  app.use(passportSession);

  const clientID = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientID || !clientSecret) {
    console.warn('[auth] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set — OAuth disabled');
  } else {
    passport.use(new GitHubStrategy(
      {
        clientID,
        clientSecret,
        callbackURL: process.env.GITHUB_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        console.log('[auth] GitHub login attempt:', profile.username, '/ allowed:', allowedUser);
        if (allowedUser && profile.username !== allowedUser) {
          return done(null, false, { message: 'Unauthorized user' });
        }
        return done(null, {
          id: profile.id,
          username: profile.username,
          avatar: profile.photos?.[0]?.value,
        });
      }
    ));
  }

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));

  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/login?error=unauthorized' }),
    (req, res) => res.redirect('/app')
  );

  app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/login'));
  });
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

/**
 * Apply session middleware to a raw HTTP upgrade request to load req.session,
 * then return whether the user is authenticated.
 */
function authenticateUpgrade(req, cb) {
  // Minimal response stub — session middleware only needs setHeader/getHeader
  // when writing a new cookie. For upgrade requests we only need to read the session.
  const stub = {
    getHeader: () => undefined,
    setHeader: () => {},
    end: () => {},
  };
  sessionMiddleware(req, stub, () => {
    // Check for passport user stored in session
    const authenticated = !!(req.session && req.session.passport && req.session.passport.user);
    cb(authenticated);
  });
}

module.exports = { setupAuth, requireAuth, authenticateUpgrade };
