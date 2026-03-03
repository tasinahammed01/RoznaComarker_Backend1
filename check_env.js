require('dotenv').config({path:'.env'});
console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('FIREBASE_PROJECT_ID exists:', !!process.env.FIREBASE_PROJECT_ID);
console.log('FIREBASE_CLIENT_EMAIL exists:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('FIREBASE_PRIVATE_KEY exists:', !!process.env.FIREBASE_PRIVATE_KEY);
