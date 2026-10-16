// Generate the two independent server secrets. Put the output in your .env.
import crypto from 'node:crypto';

console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
console.log(`OTP_PEPPER=${crypto.randomBytes(48).toString('base64url')}`);
