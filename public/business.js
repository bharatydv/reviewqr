/* ReviewQR customer flow: read the profile, verify an email once, get drafts,
   post one review. All user text is rendered with textContent. */
(function () {
  'use strict';

  var SLUG = decodeURIComponent((location.pathname.match(/^\/b\/([^/]+)/) || [])[1] || '');
  var DRAFT_KEY = 'reviewqr:draft:' + SLUG;

  var state = {
    data: null,
    rating: 0,
    topics: [],
    note: '',
    drafts: [],
    selected: -1,
    comment: '',
    email: '',
    firstName: '',
  };

  var el = function (id) {
    return document.getElementById(id);
  };

  var RATING_WORDS = {
    1: 'Poor',
    2: 'Not great',
    3: 'Mixed',
    4: 'Good',
    5: 'Excellent',
  };

  // ------------------------------------------------------------------ helpers

  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].trim();
      if (pair.indexOf(name + '=') === 0) {
        return decodeURIComponent(pair.slice(name.length + 1));
      }
    }
    return '';
  }

  function api(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var headers = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = cookie('rq_csrf');
    return fetch(path, {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!response.ok) {
            var error = new Error(data.error || 'Something went wrong. Please try again.');
            error.status = response.status;
            throw error;
          }
          return data;
        });
    });
  }

  function starString(rating) {
    var out = '';
    for (var i = 1; i <= 5; i += 1) out += i <= rating ? '★' : '☆';
    return out;
  }

  function setStars(node, rating) {
    node.textContent = '';
    for (var i = 1; i <= 5; i += 1) {
      var star = document.createElement('span');
      star.textContent = '★';
      if (i > Math.round(rating)) star.className = 'off';
      node.appendChild(star);
    }
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (error) {
      return date.toISOString().slice(0, 10);
    }
  }

  // The business's answer to a review. Built here rather than in the markup
  // because it shows up in the public list and under your own review alike.
  function replyNode(reply, repliedAt) {
    var wrap = document.createElement('div');
    wrap.className = 'reply';

    var head = document.createElement('div');
    head.className = 'review-head';

    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'Reply from ' + (state.data ? state.data.business.name : 'the business');
    head.appendChild(who);

    if (repliedAt) {
      var when = document.createElement('span');
      when.className = 'when';
      when.textContent = formatDate(repliedAt);
      head.appendChild(when);
    }

    var body = document.createElement('p');
    body.className = 'review-body';
    body.textContent = reply;

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  function status(kind, message, busy) {
    var node = el('status');
    // Errors also toast, so one that happens below the fold is still seen.
    // Successes do not: on this page they are the step itself changing, which
    // is already obvious, and a toast on top would be noise.
    if (kind === 'error' && message && !busy && window.toast) window.toast(message, 'error');
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = '';
    if (busy) {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      node.appendChild(spinner);
    }
    node.appendChild(document.createTextNode(message || ''));
  }

  function clearStatus() {
    status('', '');
  }

  // Shows exactly one step of the write-a-review flow.
  var STEPS = [
    'step-email',
    'step-code',
    'step-input',
    'step-drafts',
    'step-google',
    'step-mine',
    'step-edit',
  ];
  function showStep(id) {
    STEPS.forEach(function (step) {
      el(step).classList.toggle('hidden', step !== id);
    });
    // The Google prompt belongs with the quick input and nowhere else.
    el('google-signin').classList.toggle('hidden', !(googleReady && id === 'step-input'));
  }

  // Copies the review so it can be pasted into Google's review box. The
  // clipboard API needs a secure context, so there is a fallback for plain http
  // on a local network, and a last resort of asking the customer to copy it.
  function copyText(value, note) {
    function say(message) {
      if (note) note.textContent = message;
    }
    function fallback() {
      var scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.setAttribute('readonly', '');
      scratch.className = 'sr-only';
      document.body.appendChild(scratch);
      try {
        scratch.select();
        scratch.setSelectionRange(0, value.length);
        say(document.execCommand('copy') ? ' Copied.' : ' Copy the text above, then paste it.');
      } catch (error) {
        say(' Copy the text above, then paste it.');
      }
      document.body.removeChild(scratch);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        say(' Copied.');
      }, fallback);
      return;
    }
    fallback();
  }

  // The control is a real link, so the browser opens Google as a plain
  // navigation and no popup blocker gets involved. The copy happens alongside.
  function wireGoogleLink(anchor, note) {
    anchor.addEventListener('click', function () {
      var review = state.data && state.data.me ? state.data.me.review : null;
      var value = review ? review.comment : el('comment').value;
      if (value) copyText(value, note);
    });
  }

  // ------------------------------------------------------- Google One Tap
  //
  // Loaded only when the server was given a client id. If the customer is
  // already signed in to Google on this phone, the prompt names their account
  // and one tap identifies them - no typing, no code. Dismissing it costs them
  // nothing: the device cookie still lets them review.

  var googleLoaded = false;
  var googleReady = false;

  function onGoogleCredential(response) {
    api('/api/auth/google', { method: 'POST', body: { credential: response.credential } })
      .then(function () {
        return refresh().then(function () {
          route();
          status('ok', 'Thanks ' + (state.data.me.firstName || '') + ', you are signed in with Google.');
        });
      })
      .catch(function (error) {
        // Not fatal: they can still review as this device.
        status('error', error.message);
      });
  }

  function setUpGoogle() {
    var clientId = state.data.googleClientId;
    if (!clientId || googleLoaded || state.data.me.verified) return;
    googleLoaded = true;

    var script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = function () {
      if (!window.google || !window.google.accounts || !window.google.accounts.id) return;
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: onGoogleCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
          context: 'use',
        });
        googleReady = true;
        el('google-signin').classList.remove('hidden');
        window.google.accounts.id.renderButton(el('google-button'), {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          width: 280,
        });
        // The one-tap prompt on top of the button, for the common case where
        // they are already signed in to Google on this phone.
        window.google.accounts.id.prompt();
      } catch (error) {
        googleReady = false;
        el('google-signin').classList.add('hidden');
      }
    };
    script.onerror = function () {
      // Offline, blocked, or the script is unreachable. Reviewing still works.
      googleReady = false;
      el('google-signin').classList.add('hidden');
    };
    document.head.appendChild(script);
  }

  function googleUrl() {
    return state.data && state.data.business ? state.data.business.googleReviewUrl : '';
  }

  function busy(button, isBusy, labelWhenBusy) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = isBusy;
    button.textContent = isBusy ? labelWhenBusy || 'Working…' : button.dataset.label;
  }

  // -------------------------------------------------------------- draft saving

  function saveDraft() {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          rating: state.rating,
          topics: state.topics,
          note: state.note,
          comment: state.comment,
          drafts: state.drafts,
          selected: state.selected,
          email: state.email,
          firstName: state.firstName,
        }),
      );
    } catch (error) {
      /* storage may be unavailable; the flow still works */
    }
  }

  function loadDraft() {
    try {
      var raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      state.rating = Number(saved.rating) || 0;
      state.topics = Array.isArray(saved.topics) ? saved.topics : [];
      state.note = typeof saved.note === 'string' ? saved.note : '';
      state.comment = typeof saved.comment === 'string' ? saved.comment : '';
      state.drafts = Array.isArray(saved.drafts) ? saved.drafts : [];
      state.selected = Number.isInteger(saved.selected) ? saved.selected : -1;
      state.email = typeof saved.email === 'string' ? saved.email : '';
      state.firstName = typeof saved.firstName === 'string' ? saved.firstName : '';
    } catch (error) {
      /* ignore unreadable drafts */
    }
  }

  function clearDraft() {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- rating groups

  function wireRating(groupId, onChange) {
    var group = el(groupId);
    var inputs = group.querySelectorAll('input');
    var caption = el(groupId + '-caption');

    function paint(value) {
      group.classList.toggle('filled', value > 0);
      var labels = group.querySelectorAll('label');
      for (var i = 0; i < labels.length; i += 1) {
        labels[i].classList.toggle('on', i < value);
      }
      caption.textContent = value ? value + ' of 5 · ' + RATING_WORDS[value] : '';
    }

    for (var i = 0; i < inputs.length; i += 1) {
      inputs[i].addEventListener('change', function (event) {
        var value = Number(event.target.value);
        paint(value);
        onChange(value);
      });
    }

    return {
      set: function (value) {
        if (value >= 1 && value <= 5) {
          group.querySelectorAll('input')[value - 1].checked = true;
        } else {
          for (var j = 0; j < inputs.length; j += 1) inputs[j].checked = false;
        }
        paint(value || 0);
      },
    };
  }

  var newRating = wireRating('rating-new', function (value) {
    state.rating = value;
    saveDraft();
  });
  var editRating = wireRating('rating-edit', function () {});

  // ---------------------------------------------------------------- rendering

  function renderProfile() {
    var data = state.data;
    document.title = data.business.name + ' · ReviewQR';
    el('biz-name').textContent = data.business.name;

    var meta = [data.business.category, data.business.address].filter(Boolean).join(' · ');
    el('biz-meta').textContent = meta;
    el('biz-meta').classList.toggle('hidden', !meta);
    el('biz-description').textContent = data.business.description || '';
    el('biz-description').classList.toggle('hidden', !data.business.description);

    var stats = data.stats;
    el('avg').textContent = stats.count ? stats.average.toFixed(1) : '–';
    setStars(el('avg-stars'), stats.average);
    el('avg-count').textContent = stats.count === 1 ? '1 review' : stats.count + ' reviews';
    el('avg-sr').textContent = stats.count
      ? 'Average rating ' + stats.average.toFixed(1) + ' out of 5, from ' + stats.count + ' reviews.'
      : 'No ratings yet.';

    var breakdown = el('breakdown');
    breakdown.textContent = '';
    for (var star = 5; star >= 1; star -= 1) {
      var value = stats.breakdown[star] || 0;
      var share = stats.count ? Math.round((value / stats.count) * 100) : 0;

      var row = document.createElement('div');
      row.className = 'breakdown-row';

      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = star + ' star';

      var bar = document.createElement('span');
      bar.className = 'bar';
      var fill = document.createElement('span');
      // Set through CSSOM, so the page needs no inline style attributes.
      fill.style.width = share + '%';
      bar.appendChild(fill);

      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(value);

      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(count);
      row.setAttribute('aria-label', value + ' of ' + stats.count + ' reviews gave ' + star + ' stars');
      breakdown.appendChild(row);
    }

    var list = el('reviews');
    list.textContent = '';
    data.reviews.forEach(function (review) {
      var item = document.createElement('li');

      var head = document.createElement('div');
      head.className = 'review-head';

      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = review.firstName;

      var stars = document.createElement('span');
      stars.className = 'stars';
      stars.setAttribute('aria-hidden', 'true');
      stars.textContent = starString(review.rating);

      var sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = review.rating + ' out of 5 stars';

      var when = document.createElement('span');
      when.className = 'when';
      when.textContent = formatDate(review.createdAt);

      head.appendChild(who);
      head.appendChild(stars);
      head.appendChild(sr);
      head.appendChild(when);

      var body = document.createElement('p');
      body.className = 'review-body';
      body.textContent = review.comment;

      item.appendChild(head);
      item.appendChild(body);
      if (review.reply) item.appendChild(replyNode(review.reply, review.repliedAt));
      list.appendChild(item);
    });

    el('reviews-empty').classList.toggle('hidden', data.reviews.length > 0);
    el('reviews-note').textContent =
      stats.count > data.reviews.length
        ? 'Showing the ' + data.reviews.length + ' most recent of ' + stats.count + '.'
        : '';
  }

  function renderChips() {
    var chips = el('chips');
    if (chips.dataset.ready) return;
    chips.dataset.ready = '1';
    state.data.topics.forEach(function (topic, index) {
      var id = 'topic-' + index;
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.value = topic;
      input.checked = state.topics.indexOf(topic) !== -1;
      input.addEventListener('change', function () {
        if (input.checked) {
          if (state.topics.indexOf(topic) === -1) state.topics.push(topic);
        } else {
          state.topics = state.topics.filter(function (entry) {
            return entry !== topic;
          });
        }
        saveDraft();
      });

      var label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = topic;

      chips.appendChild(input);
      chips.appendChild(label);
    });
  }

  function shapeOf(text) {
    if (text.length < 110) return 'Short';
    if (text.length < 220) return 'Medium';
    return 'Longer';
  }

  function renderDrafts() {
    var container = el('drafts');
    container.textContent = '';
    state.drafts.forEach(function (text, index) {
      var wrapper = document.createElement('div');
      wrapper.className = 'draft';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'draft';
      input.id = 'draft-' + index;
      input.checked = index === state.selected;
      input.addEventListener('change', function () {
        state.selected = index;
        state.comment = text;
        el('comment').value = text;
        updateCounter();
        saveDraft();
        el('comment').focus();
      });

      var label = document.createElement('label');
      label.setAttribute('for', 'draft-' + index);
      var shape = document.createElement('span');
      shape.className = 'shape';
      shape.textContent = shapeOf(text) + ' · ' + text.length + ' characters';
      var body = document.createElement('span');
      body.textContent = text;
      label.appendChild(shape);
      label.appendChild(body);

      wrapper.appendChild(input);
      wrapper.appendChild(label);
      container.appendChild(wrapper);
    });
  }

  function counterFor(textarea, counter) {
    var limits = state.data.limits;
    var length = textarea.value.trim().length;
    var short = length < limits.commentMin;
    counter.textContent = short
      ? length + ' of ' + limits.commentMin + ' characters needed'
      : length + ' / ' + limits.commentMax + ' characters';
    counter.classList.toggle('over', short || length > limits.commentMax);
    return !short && length <= limits.commentMax;
  }

  function updateCounter() {
    var ok = counterFor(el('comment'), el('comment-counter'));
    el('post-review').disabled = !ok;
  }

  function renderMine() {
    var mine = state.data.me.review;
    setStars(el('mine-stars'), mine.rating);
    el('mine-when').textContent = formatDate(mine.createdAt);
    el('mine-comment').textContent = mine.comment;
    el('mine-hidden').classList.toggle('hidden', mine.status !== 'hidden');

    var reply = el('mine-reply');
    reply.textContent = '';
    reply.classList.toggle('hidden', !mine.reply);
    if (mine.reply) reply.appendChild(replyNode(mine.reply, mine.repliedAt));

    var url = googleUrl();
    el('mine-google').classList.toggle('hidden', !url);
    el('mine-google-copied').textContent = '';
    if (url) el('mine-google-link').href = url;
  }

  // Only shown to the few customers who went through email verification.
  function renderSignedIn() {
    var me = state.data.me;
    el('signed-in-as').classList.toggle('hidden', !me.verified);
    if (me.verified) el('signed-in-name').textContent = me.firstName || 'you';
  }

  // Decides which step the customer should see.
  function route() {
    var me = state.data.me;
    renderSignedIn();

    // Nothing is asked of the customer unless this business insists on a
    // verified email. Normally they go straight to the stars.
    if (state.data.business.requireEmail && !me.verified) {
      el('email').value = state.email;
      el('first-name').value = state.firstName;
      showStep('step-email');
      return;
    }
    if (me.suspended) {
      showStep(null);
      status('error', 'This account cannot post reviews. Please speak to the business.');
      return;
    }
    if (me.review) {
      renderMine();
      showStep('step-mine');
      return;
    }
    if (state.drafts.length) {
      renderChips();
      renderDrafts();
      el('comment').value = state.comment;
      updateCounter();
      showStep('step-drafts');
      return;
    }
    renderChips();
    newRating.set(state.rating);
    el('note').value = state.note;
    showStep('step-input');
    setUpGoogle();
  }

  function load() {
    return api('/api/b/' + encodeURIComponent(SLUG))
      .then(function (data) {
        state.data = data;
        el('load-status').classList.add('hidden');
        el('profile').classList.remove('hidden');
        renderProfile();
        route();
      })
      .catch(function (error) {
        el('load-status').classList.add('hidden');
        if (error.status === 404) {
          el('not-found').classList.remove('hidden');
          return;
        }
        el('load-status').classList.remove('hidden');
        el('load-status').className = 'status error';
        el('load-status').textContent =
          'We could not load this page: ' + error.message + ' Please check your connection and reload.';
      });
  }

  function refresh() {
    return api('/api/b/' + encodeURIComponent(SLUG)).then(function (data) {
      state.data = data;
      renderProfile();
      renderSignedIn();
    });
  }

  // -------------------------------------------------------------------- events

  el('step-email').addEventListener('submit', function (event) {
    event.preventDefault();
    var email = el('email').value.trim();
    var firstName = el('first-name').value.trim();
    if (!email || email.indexOf('@') === -1) {
      status('error', 'Please enter an email address like you@example.com.');
      el('email').focus();
      return;
    }
    if (firstName.length < 2) {
      status('error', 'Please enter your first name, at least 2 characters.');
      el('first-name').focus();
      return;
    }
    state.email = email;
    state.firstName = firstName;
    saveDraft();

    var button = el('send-code');
    busy(button, true, 'Sending…');
    status('working', 'Sending your code.', true);
    api('/api/auth/request-code', {
      method: 'POST',
      body: { email: email, firstName: firstName, company: el('company').value },
    })
      .then(function (data) {
        status('ok', data.message);
        el('code-sent-to').textContent = 'We sent a 6-digit code to ' + email + '.';
        showStep('step-code');
        el('code').focus();
      })
      .catch(function (error) {
        status('error', error.message);
      })
      .then(function () {
        busy(button, false);
      });
  });

  el('step-code').addEventListener('submit', function (event) {
    event.preventDefault();
    var code = el('code').value.replace(/\D/g, '');
    if (code.length !== 6) {
      status('error', 'The code is 6 digits. Please check the email and try again.');
      return;
    }
    var button = el('verify-code');
    busy(button, true, 'Checking…');
    status('working', 'Checking your code.', true);
    api('/api/auth/verify-code', {
      method: 'POST',
      body: { email: state.email, code: code, firstName: state.firstName },
    })
      .then(function () {
        el('code').value = '';
        clearStatus();
        return refresh().then(route);
      })
      .catch(function (error) {
        status('error', error.message);
        el('code').focus();
      })
      .then(function () {
        busy(button, false);
      });
  });

  el('resend-code').addEventListener('click', function () {
    var button = el('resend-code');
    busy(button, true, 'Sending…');
    api('/api/auth/request-code', {
      method: 'POST',
      body: { email: state.email, firstName: state.firstName, company: '' },
    })
      .then(function (data) {
        status('ok', data.message);
      })
      .catch(function (error) {
        status('error', error.message);
      })
      .then(function () {
        busy(button, false);
      });
  });

  el('change-email').addEventListener('click', function () {
    clearStatus();
    showStep('step-email');
    el('email').focus();
  });

  el('note').addEventListener('input', function () {
    state.note = el('note').value;
    saveDraft();
  });

  function requestDrafts(button, label) {
    if (!state.rating) {
      status('error', 'Please choose a star rating first.');
      el('rating-new-5').focus();
      return;
    }
    busy(button, true, label);
    status('working', 'Writing a few drafts from what you told us.', true);
    api('/api/suggest', {
      method: 'POST',
      body: { slug: SLUG, rating: state.rating, topics: state.topics, note: state.note },
    })
      .then(function (data) {
        state.drafts = data.drafts;
        state.selected = 0;
        state.comment = data.drafts[0] || '';
        saveDraft();
        renderDrafts();
        el('comment').value = state.comment;
        updateCounter();
        showStep('step-drafts');
        status(
          'ok',
          data.source === 'ai'
            ? 'Here are ' + data.drafts.length + ' drafts. Pick one and make it yours.'
            : 'Here are ' + data.drafts.length + ' starting points. Pick one and make it yours.',
        );
        el('drafts').scrollIntoView({ block: 'start' });
      })
      .catch(function (error) {
        status('error', error.message);
      })
      .then(function () {
        busy(button, false);
      });
  }

  el('step-input').addEventListener('submit', function (event) {
    event.preventDefault();
    if (el('company-2').value) {
      status('error', 'That submission looked automated. Please try again.');
      return;
    }
    requestDrafts(el('suggest'), 'Thinking…');
  });

  el('regenerate').addEventListener('click', function () {
    requestDrafts(el('regenerate'), 'Thinking…');
  });

  el('comment').addEventListener('input', function () {
    state.comment = el('comment').value;
    state.selected = -1;
    updateCounter();
    saveDraft();
  });

  el('post-review').addEventListener('click', function () {
    var comment = el('comment').value.trim();
    if (!counterFor(el('comment'), el('comment-counter'))) {
      status('error', 'Your review needs to be between 20 and 400 characters.');
      el('comment').focus();
      return;
    }
    var button = el('post-review');
    busy(button, true, 'Posting…');
    status('working', 'Posting your review.', true);
    api('/api/b/' + encodeURIComponent(SLUG) + '/reviews', {
      method: 'POST',
      body: { rating: state.rating, comment: comment, company: '' },
    })
      .then(function () {
        clearDraft();
        state.drafts = [];
        state.selected = -1;
        state.comment = '';
        return refresh().then(function () {
          renderMine();
          // With a Google link set up, offer to post the same words there too.
          if (googleUrl()) {
            el('google-text').value = state.data.me.review.comment;
            // Name the rating they just gave, so Google gets the same one. We
            // cannot select it for them: those stars are on Google's page.
            var stars = state.data.me.review.rating;
            el('google-stars-hint').textContent =
              'Tap ' + stars + ' star' + (stars === 1 ? '' : 's') + ' on Google, then tap Post.';
            el('google-link').href = googleUrl();
            el('google-copied').textContent = '';
            clearStatus();
            showStep('step-google');
          } else {
            route();
            status('ok', 'Thank you. Your review is live and it is at the top of the list.');
          }
          el('biz-name').scrollIntoView({ block: 'start' });
        });
      })
      .catch(function (error) {
        status('error', error.message);
        if (error.status === 409) refresh().then(route);
      })
      .then(function () {
        busy(button, false);
      });
  });

  wireGoogleLink(el('google-link'), el('google-copied'));
  wireGoogleLink(el('mine-google-link'), el('mine-google-copied'));

  el('google-done').addEventListener('click', function () {
    route();
    status('ok', 'Thank you. Your review is live and it is at the top of the list.');
  });

  el('edit-review').addEventListener('click', function () {
    var mine = state.data.me.review;
    editRating.set(mine.rating);
    el('edit-comment').value = mine.comment;
    counterFor(el('edit-comment'), el('edit-counter'));
    // Saying so up front, because a saved change drops the business's answer.
    el('edit-reply-note').classList.toggle('hidden', !mine.reply);
    clearStatus();
    showStep('step-edit');
    el('edit-comment').focus();
  });

  el('edit-comment').addEventListener('input', function () {
    var ok = counterFor(el('edit-comment'), el('edit-counter'));
    el('save-edit').disabled = !ok;
  });

  el('cancel-edit').addEventListener('click', function () {
    clearStatus();
    route();
  });

  el('step-edit').addEventListener('submit', function (event) {
    event.preventDefault();
    var checked = el('rating-edit').querySelector('input:checked');
    var comment = el('edit-comment').value.trim();
    if (!counterFor(el('edit-comment'), el('edit-counter'))) {
      status('error', 'Your review needs to be between 20 and 400 characters.');
      return;
    }
    var button = el('save-edit');
    busy(button, true, 'Saving…');
    api('/api/b/' + encodeURIComponent(SLUG) + '/reviews/me', {
      method: 'PUT',
      body: { rating: checked ? Number(checked.value) : undefined, comment: comment },
    })
      .then(function () {
        return refresh().then(function () {
          route();
          status('ok', 'Your review has been updated.');
        });
      })
      .catch(function (error) {
        status('error', error.message);
      })
      .then(function () {
        busy(button, false);
      });
  });

  el('delete-review').addEventListener('click', function () {
    if (!window.confirm('Delete your review for this business?')) return;
    var button = el('delete-review');
    busy(button, true, 'Deleting…');
    api('/api/b/' + encodeURIComponent(SLUG) + '/reviews/me', { method: 'DELETE' })
      .then(function () {
        clearDraft();
        state.rating = 0;
        state.topics = [];
        state.note = '';
        state.comment = '';
        state.drafts = [];
        return refresh().then(function () {
          route();
          status('ok', 'Your review has been deleted. You can write a new one whenever you like.');
        });
      })
      .catch(function (error) {
        status('error', error.message);
      })
      .then(function () {
        busy(button, false);
      });
  });

  el('sign-out').addEventListener('click', function () {
    api('/api/auth/logout', { method: 'POST' })
      .then(function () {
        clearDraft();
        return refresh().then(route);
      })
      .catch(function (error) {
        status('error', error.message);
      });
  });

  // ---------------------------------------------------------------- bootstrap

  if (!SLUG) {
    el('load-status').classList.add('hidden');
    el('not-found').classList.remove('hidden');
  } else {
    loadDraft();
    load();
  }
})();
