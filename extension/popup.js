const STORAGE_KEY = 'meetTranscriptEnabled';

document.addEventListener('DOMContentLoaded', () => {
  const cb = document.getElementById('enabled');
  chrome.storage.local.get([STORAGE_KEY], (data) => {
    cb.checked = data[STORAGE_KEY] !== false;
  });
  cb.addEventListener('change', () => {
    chrome.storage.local.set({ [STORAGE_KEY]: cb.checked });
  });
});
