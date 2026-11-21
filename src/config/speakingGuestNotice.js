'use strict';
// The notice a guest accepts before uploading a recording (stage 10). The ONE place its wording and version live: the guest entry endpoint sends
// both to the page, and the upload stores the accepted version with the time. Change the text -> change the version, so every stored consent
// still says which wording was accepted. A guest must send this exact version; an older one is refused (the page reloads the notice).
const SPEAKING_GUEST_NOTICE_VERSION = 'speaking-guest-2026-11';
const SPEAKING_GUEST_NOTICE_TEXT = 'Your recording and its transcript are saved with your submission and shared with your teacher. The audio is sent to a '
  + 'speech-to-text service to create the transcript, and the result is marked with AI to help your teacher. It is kept until your teacher deletes the '
  + 'submission. If you are under 18, ask a parent or guardian before recording.';

module.exports = Object.freeze({ SPEAKING_GUEST_NOTICE_VERSION, SPEAKING_GUEST_NOTICE_TEXT });
