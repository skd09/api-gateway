// =================================================================
// Start all services: 3 backends + gateway
// =================================================================

console.log('');
console.log('🚀 Starting Notification Engine — API Gateway');
console.log('');

// Start backends first
import './backends';

// Start gateway after a short delay (let backends boot)
setTimeout(() => {
    import('./gateway');
}, 500);