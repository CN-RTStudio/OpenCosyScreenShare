const { ipcRenderer } = require('electron');

const codeValue = document.getElementById('codeValue');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const exitBtn = document.getElementById('exitBtn');

ipcRenderer.on('code-ready', (event, code) => {
  codeValue.innerHTML = '';
  const codeSpan = document.createElement('span');
  codeSpan.textContent = code;
  codeValue.appendChild(codeSpan);
});

ipcRenderer.on('connection-status', (event, connected) => {
  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected - Displaying';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Waiting for connection';
  }
});

exitBtn.addEventListener('click', () => {
  ipcRenderer.send('exit-app');
});
