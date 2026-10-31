// Sign-in for the Last Call admin. The server checks everything; this only
// sends the form as JSON (a same-origin request) and reports the result.

const form = document.getElementById('signin');
const error = document.getElementById('signin-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';
  const data = new FormData(form);
  let res;
  try {
    res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: data.get('username'), password: data.get('password'), code: String(data.get('code') || '') }),
    });
  } catch {
    res = null;
  }
  if (res?.ok) {
    location.replace('/admin');
    return;
  }
  let message = 'Could not reach the server. Check your connection and try again.';
  if (res) {
    try {
      message = (await res.json()).message || message;
    } catch {
      // keep the generic message
    }
  }
  form.querySelector('[name="password"]').value = '';
  form.querySelector('[name="code"]').value = '';
  error.textContent = message;
  error.hidden = false;
  button.disabled = false;
  button.textContent = 'Sign in';
});
