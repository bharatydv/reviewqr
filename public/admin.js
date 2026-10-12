/* ReviewQR admin console.

   Signing in is an email and a password; the session is an httpOnly cookie, so
   nothing here holds a credential and there is nothing for a script on the page
   to steal. All text is rendered with textContent. */
(function () {
  'use strict';

  var el = function (id) {
    return document.getElementById(id);
  };

  // Confirmations go to a toast: the inline bar lives at the top of the page,
  // and by the time you have scrolled to the tenth business and deleted it,
  // a message up there is off screen and may as well not exist. Errors do
  // both - a toast to be noticed, and the inline bar so it is still readable
  // after the toast has gone.
  function status(kind, message) {
    var node = el('status');
    if (kind === 'ok' && message && window.toast) {
      node.className = 'status';
      node.textContent = '';
      window.toast(message);
      return;
    }
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = message || '';
    if (kind === 'error' && message && window.toast) window.toast(message, 'error');
  }

  // The CSRF cookie is readable on purpose: mutating requests echo it back in
  // the header, and the server compares the two (double submit).
  function cookie(name) {
    var match = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  function api(path, options) {
    options = options || {};
    var headers = {};
    var method = options.method || 'GET';
    if (method !== 'GET') headers['x-csrf-token'] = cookie('rq_csrf');
    if (options.body !== undefined) headers['content-type'] = 'application/json';
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

  function button(label, className, onClick) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    node.addEventListener('click', function () {
      onClick(node);
    });
    return node;
  }

  function link(label, href, download) {
    var node = document.createElement('a');
    node.className = 'button-link';
    node.href = href;
    node.textContent = label;
    if (download) node.setAttribute('download', '');
    return node;
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  }

  // One labelled field for the inline edit form.
  function field(id, label, value, hint) {
    var wrap = document.createDocumentFragment();
    var labelNode = document.createElement('label');
    labelNode.setAttribute('for', id);
    labelNode.textContent = label;
    var input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.value = value || '';
    wrap.appendChild(labelNode);
    wrap.appendChild(input);
    if (hint) wrap.appendChild(text('p', 'hint', hint));
    return { fragment: wrap, input: input };
  }

  // One labelled checkbox: a per-business switch in the inline edit form.
  function switchBox(id, label, checked, hint) {
    var wrap = document.createDocumentFragment();
    var check = document.createElement('div');
    check.className = 'check';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = Boolean(checked);
    var labelNode = document.createElement('label');
    labelNode.setAttribute('for', id);
    labelNode.textContent = label;
    check.appendChild(input);
    check.appendChild(labelNode);
    wrap.appendChild(check);
    if (hint) wrap.appendChild(text('p', 'hint', hint));
    return { fragment: wrap, input: input };
  }

  // Edits everything except the slug, which stays fixed so printed QR codes
  // keep pointing at the right page.
  function editForm(business, onSaved) {
    var form = document.createElement('form');
    form.className = 'card';
    form.appendChild(text('h3', null, 'Edit ' + business.name));
    form.appendChild(text('p', 'muted small', 'Web address stays ' + business.url));

    var prefix = 'edit-' + business.id + '-';
    var name = field(prefix + 'name', 'Name', business.name);
    var category = field(prefix + 'category', 'Category', business.category);
    var address = field(prefix + 'address', 'Address', business.address);
    var description = field(prefix + 'description', 'Description', business.description);
    var topics = field(
      prefix + 'topics',
      'Topic chips',
      (business.topics || []).join(', '),
      'Comma separated, up to 8.',
    );
    var google = field(
      prefix + 'google',
      'Google review link',
      business.googleReviewUrl,
      'Leave empty to hide the "post on Google" step.',
    );

    [name, category, address, description, topics, google].forEach(function (entry) {
      form.appendChild(entry.fragment);
    });

    var requireEmail = switchBox(
      prefix + 'require-email',
      'Ask reviewers to verify an email first',
      business.requireEmail,
      'Off by default. Most people give up at the email step.',
    );
    var aiDrafts = switchBox(
      prefix + 'ai-drafts',
      'Offer AI-written drafts',
      business.aiDrafts,
      'Off means template drafts for this business, and no model call at all.',
    );
    var googleSignin = switchBox(
      prefix + 'google-signin',
      'Offer Google sign-in',
      business.googleSignin,
      'Off means this business never shows the Google prompt.',
    );
    [requireEmail, aiDrafts, googleSignin].forEach(function (entry) {
      form.appendChild(entry.fragment);
    });

    var actions = document.createElement('div');
    actions.className = 'row';
    var cancel = button('Cancel', 'secondary', function () {
      onSaved(false);
    });
    var save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save changes';
    actions.appendChild(cancel);
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      save.disabled = true;
      api('/api/admin/businesses/' + business.id, {
        method: 'PATCH',
        body: {
          name: name.input.value.trim(),
          category: category.input.value.trim(),
          address: address.input.value.trim(),
          description: description.input.value.trim(),
          topics: topics.input.value,
          googleReviewUrl: google.input.value.trim(),
          requireEmail: requireEmail.input.checked,
          aiDrafts: aiDrafts.input.checked,
          googleSignin: googleSignin.input.checked,
        },
      })
        .then(function (data) {
          status('ok', data.business.name + ' has been updated.');
          onSaved(true);
        })
        .catch(function (error) {
          save.disabled = false;
          handle(error);
        });
    });

    return form;
  }

  function handle(error) {
    // A session that expired while the tab sat open looks like this. Drop to
    // the sign-in form rather than leaving a console that no longer works.
    if (error.status === 401) {
      signOut('Your session has ended. Please sign in again.');
      return;
    }
    status('error', error.message);
  }

  // -------------------------------------------------------------- businesses

  // The whole list is fetched once and filtered here rather than on the server.
  // At this size a round trip per keystroke would be slower and no more
  // correct; if this ever holds thousands of businesses, this is the piece to
  // move server side.
  var businesses = [];
  var bizView = { query: '', sort: 'name', page: 1, perPage: 10 };

  function matchingBusinesses() {
    var query = bizView.query.trim().toLowerCase();
    var found = businesses.filter(function (business) {
      if (!query) return true;
      // Address and category are searched too: with many venues, "the one on
      // Harbour Lane" is often how you remember it.
      return [business.name, business.category, business.address, business.slug]
        .filter(Boolean)
        .some(function (field) {
          return String(field).toLowerCase().indexOf(query) !== -1;
        });
    });

    return found.sort(function (a, b) {
      if (bizView.sort === 'reviews') return (b.reviewCount || 0) - (a.reviewCount || 0);
      // A business with no reviews has no average to rank by, so it sorts last
      // rather than as a zero, which would read as "rated badly".
      if (bizView.sort === 'rating') {
        if (!a.reviewCount && !b.reviewCount) return 0;
        if (!a.reviewCount) return 1;
        if (!b.reviewCount) return -1;
        return (b.average || 0) - (a.average || 0);
      }
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function renderPager(total) {
    var pages = Math.max(1, Math.ceil(total / bizView.perPage));
    el('business-pager').classList.toggle('hidden', pages < 2);
    el('business-page-label').textContent = 'Page ' + bizView.page + ' of ' + pages;
    el('business-prev').disabled = bizView.page <= 1;
    el('business-next').disabled = bizView.page >= pages;

    var count = el('business-count');
    if (!businesses.length) count.textContent = '';
    else if (total === businesses.length) {
      count.textContent = total + (total === 1 ? ' business' : ' businesses');
    } else {
      count.textContent = total + ' of ' + businesses.length + ' businesses';
    }
  }

  function loadBusinesses() {
    return api('/api/admin/businesses').then(function (data) {
      businesses = data.businesses || [];
      renderBusinesses();
    });
  }

  function renderBusinesses() {
    var list = el('business-list');
    list.textContent = '';

    var matches = matchingBusinesses();
    var pages = Math.max(1, Math.ceil(matches.length / bizView.perPage));
    // Deleting the last row of the last page, or typing a narrower search,
    // can leave us past the end.
    if (bizView.page > pages) bizView.page = pages;

    var empty = el('business-empty');
    empty.classList.toggle('hidden', matches.length > 0);
    empty.textContent = businesses.length
      ? 'No businesses match that search.'
      : 'No businesses yet. Add the first one above.';

    el('business-controls').classList.toggle('hidden', businesses.length < 2);

    var from = (bizView.page - 1) * bizView.perPage;
    matches.slice(from, from + bizView.perPage).forEach(function (business) {
        var row = document.createElement('div');
        row.className = 'biz';

        var img = document.createElement('img');
        img.className = 'qr-thumb';
        img.src = business.qrPng;
        img.alt = 'QR code for ' + business.name;
        img.width = 92;
        img.height = 92;

        var main = document.createElement('div');
        main.className = 'biz-main';
        main.appendChild(text('h3', null, business.name));
        main.appendChild(
          text(
            'p',
            'meta',
            [business.category, business.address].filter(Boolean).join(' · ') || 'No category set',
          ),
        );

        var stats = business.reviewCount
          ? business.visibleCount +
            ' visible of ' +
            business.reviewCount +
            ' reviews · average ' +
            business.average
          : 'No reviews yet';
        main.appendChild(text('p', 'muted small', stats));

        var urlLine = document.createElement('p');
        urlLine.className = 'small';
        var profile = document.createElement('a');
        profile.href = '/b/' + business.slug;
        profile.textContent = business.url;
        urlLine.appendChild(profile);
        main.appendChild(urlLine);

        main.appendChild(text('p', 'muted small', 'Topics: ' + (business.topics || []).join(', ')));
        if (business.requireEmail) {
          main.appendChild(text('p', 'muted small', 'Reviewers must verify an email'));
        }
        var off = [];
        if (!business.aiDrafts) off.push('AI drafts');
        if (!business.googleSignin) off.push('Google sign-in');
        if (off.length) {
          main.appendChild(text('p', 'muted small', 'Switched off here: ' + off.join(', ')));
        }
        main.appendChild(
          text(
            'p',
            'muted small',
            business.googleReviewUrl
              ? 'Google: customers are offered the post-to-Google step'
              : 'Google: no link set, so that step is hidden',
          ),
        );

        var actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.appendChild(
          button('Edit', 'secondary', function () {
            var open = row.nextSibling;
            if (open && open.dataset && open.dataset.editor === String(business.id)) {
              open.remove();
              return;
            }
            var form = editForm(business, function (changed) {
              if (changed) loadBusinesses().catch(handle);
              else form.remove();
            });
            form.dataset.editor = String(business.id);
            row.after(form);
            form.querySelector('input').focus();
          }),
        );
        actions.appendChild(link('Download PNG', business.qrPng + '?download=1', true));
        actions.appendChild(link('Download SVG', business.qrSvg + '?download=1', true));

        // A new tab, not a download: the poster is a page you adjust and then
        // print, and losing this list to get there would be a poor trade.
        var poster = link('Print poster', '/b/' + business.slug + '/poster');
        poster.target = '_blank';
        poster.rel = 'noopener';
        actions.appendChild(poster);
        actions.appendChild(
          button('Reviews', 'secondary', function () {
            showPanel('reviews');
            loadReviews(business.id, business.name);
          }),
        );
        actions.appendChild(
          button('Delete', 'danger', function (node) {
            if (
              !window.confirm(
                'Delete ' + business.name + ' and all of its reviews? This cannot be undone.',
              )
            ) {
              return;
            }
            node.disabled = true;
            api('/api/admin/businesses/' + business.id, { method: 'DELETE' })
              .then(function () {
                status('ok', business.name + ' has been deleted.');
                return loadBusinesses();
              })
              .catch(function (error) {
                node.disabled = false;
                handle(error);
              });
          }),
        );
        main.appendChild(actions);

        row.appendChild(img);
        row.appendChild(main);
        list.appendChild(row);
    });

    renderPager(matches.length);
  }

  el('business-search').addEventListener('input', function (event) {
    bizView.query = event.target.value;
    bizView.page = 1;
    renderBusinesses();
  });

  el('business-sort').addEventListener('change', function (event) {
    bizView.sort = event.target.value;
    bizView.page = 1;
    renderBusinesses();
  });

  el('business-prev').addEventListener('click', function () {
    if (bizView.page > 1) bizView.page -= 1;
    renderBusinesses();
  });

  el('business-next').addEventListener('click', function () {
    bizView.page += 1;
    renderBusinesses();
  });

  el('create-business').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = el('name').value.trim();
    if (name.length < 2) {
      status('error', 'Please give the business a name of at least 2 characters.');
      el('name').focus();
      return;
    }
    var submit = el('create-button');
    submit.disabled = true;
    api('/api/admin/businesses', {
      method: 'POST',
      body: {
        name: name,
        category: el('category').value.trim(),
        address: el('address').value.trim(),
        description: el('description').value.trim(),
        topics: el('topics').value,
        googleReviewUrl: el('google-review-url').value.trim(),
        requireEmail: el('require-email').checked,
        aiDrafts: el('ai-drafts').checked,
        googleSignin: el('google-signin').checked,
      },
    })
      .then(function (data) {
        status('ok', data.business.name + ' is live at ' + data.business.url);
        el('create-business').reset();
        return loadBusinesses();
      })
      .catch(handle)
      .then(function () {
        submit.disabled = false;
      });
  });

  // ----------------------------------------------------------------- reviews

  // The business's public answer to one review: written, changed or taken
  // down in place, without leaving the moderation list.
  function replyEditor(review, onDone) {
    var form = document.createElement('form');
    form.className = 'reply-form';

    var id = 'reply-' + review.id;
    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = review.reply ? 'Edit the reply' : 'Reply publicly';

    var box = document.createElement('textarea');
    box.id = id;
    box.maxLength = 600;
    box.value = review.reply || '';

    form.appendChild(label);
    form.appendChild(box);
    form.appendChild(
      text('p', 'hint', 'Shown under the review on the public page, under the business name.'),
    );

    var actions = document.createElement('div');
    actions.className = 'inline-actions';

    var save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save reply';
    actions.appendChild(save);
    actions.appendChild(
      button('Cancel', 'secondary', function () {
        onDone();
      }),
    );
    if (review.reply) {
      actions.appendChild(
        button('Remove reply', 'danger', function (node) {
          if (!window.confirm('Take this reply off the public page?')) return;
          node.disabled = true;
          api('/api/admin/reviews/' + review.id + '/reply', { method: 'DELETE' })
            .then(function () {
              status('ok', 'Reply removed.');
              onDone();
            })
            .catch(function (error) {
              node.disabled = false;
              handle(error);
            });
        }),
      );
    }
    form.appendChild(actions);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var reply = box.value.trim();
      if (!reply) {
        status('error', 'Write a reply first, or cancel.');
        return;
      }
      save.disabled = true;
      api('/api/admin/reviews/' + review.id + '/reply', { method: 'PUT', body: { reply: reply } })
        .then(function () {
          status('ok', 'Reply published.');
          onDone();
        })
        .catch(function (error) {
          save.disabled = false;
          handle(error);
        });
    });

    return { form: form, textarea: box };
  }

  function loadReviews(businessId, businessName) {
    var path = businessId ? '/api/admin/businesses/' + businessId + '/reviews' : '/api/admin/reviews';
    return api(path).then(function (data) {
      var list = el('review-list');
      list.textContent = '';
      el('review-empty').classList.toggle('hidden', data.reviews.length > 0);
      el('mod-heading').textContent = businessName
        ? 'Moderate reviews · ' + businessName
        : 'Moderate reviews';

      if (businessId) {
        var all = document.createElement('p');
        all.appendChild(
          button('Show every business', 'secondary', function () {
            loadReviews(null, null);
          }),
        );
        list.appendChild(all);
      }

      data.reviews.forEach(function (review) {
        var row = document.createElement('div');
        row.className = 'mod-row';

        var head = document.createElement('div');
        head.className = 'review-head';
        head.appendChild(text('span', 'who', review.user.label));
        head.appendChild(text('span', 'stars', '★'.repeat(review.rating)));
        head.appendChild(text('span', 'when', new Date(review.createdAt).toLocaleDateString()));
        if (review.status === 'hidden') head.appendChild(text('span', 'badge', 'Hidden'));
        if (review.user.suspended) head.appendChild(text('span', 'badge', 'Suspended'));
        if (review.businessName) head.appendChild(text('span', 'when', review.businessName));
        row.appendChild(head);
        row.appendChild(text('p', 'review-body', review.comment));

        if (review.reply) {
          var reply = document.createElement('div');
          reply.className = 'reply';
          var replyHead = document.createElement('div');
          replyHead.className = 'review-head';
          replyHead.appendChild(text('span', 'who', 'Your reply'));
          if (review.repliedAt) {
            replyHead.appendChild(
              text('span', 'when', new Date(review.repliedAt).toLocaleDateString()),
            );
          }
          reply.appendChild(replyHead);
          reply.appendChild(text('p', 'review-body', review.reply));
          row.appendChild(reply);
        }

        var actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.appendChild(
          button(review.reply ? 'Edit reply' : 'Reply', 'secondary', function (node) {
            node.disabled = true;
            var editor = replyEditor(review, function () {
              loadReviews(businessId, businessName);
            });
            row.appendChild(editor.form);
            editor.textarea.focus();
          }),
        );
        var next = review.status === 'visible' ? 'hidden' : 'visible';
        actions.appendChild(
          button(next === 'hidden' ? 'Hide' : 'Show', 'secondary', function (node) {
            node.disabled = true;
            api('/api/admin/reviews/' + review.id, { method: 'PATCH', body: { status: next } })
              .then(function () {
                status('ok', 'Review ' + (next === 'hidden' ? 'hidden.' : 'visible again.'));
                return loadReviews(businessId, businessName);
              })
              .catch(function (error) {
                node.disabled = false;
                handle(error);
              });
          }),
        );
        actions.appendChild(
          button('Delete', 'danger', function (node) {
            if (!window.confirm('Delete this review permanently?')) return;
            node.disabled = true;
            api('/api/admin/reviews/' + review.id, { method: 'DELETE' })
              .then(function () {
                status('ok', 'Review deleted.');
                return loadReviews(businessId, businessName);
              })
              .catch(function (error) {
                node.disabled = false;
                handle(error);
              });
          }),
        );
        actions.appendChild(
          button(
            review.user.suspended ? 'Unsuspend person' : 'Suspend person',
            'secondary',
            function (node) {
              node.disabled = true;
              api('/api/admin/users/' + review.user.id, {
                method: 'PATCH',
                body: { suspended: !review.user.suspended },
              })
                .then(function () {
                  status('ok', 'Updated ' + review.user.label + '.');
                  return loadReviews(businessId, businessName);
                })
                .catch(function (error) {
                  node.disabled = false;
                  handle(error);
                });
            },
          ),
        );
        row.appendChild(actions);
        list.appendChild(row);
      });
    });
  }

  // ------------------------------------------------------------------ people

  function loadPeople() {
    return api('/api/admin/users').then(function (data) {
      var list = el('people-list');
      list.textContent = '';
      el('people-empty').classList.toggle('hidden', data.users.length > 0);

      data.users.forEach(function (user) {
        var row = document.createElement('div');
        row.className = 'mod-row';

        var head = document.createElement('div');
        head.className = 'review-head';
        head.appendChild(text('span', 'who', user.label));
        head.appendChild(text('span', 'when', user.firstName));
        head.appendChild(
          text('span', 'when', user.reviewCount === 1 ? '1 review' : user.reviewCount + ' reviews'),
        );
        if (user.suspended) head.appendChild(text('span', 'badge', 'Suspended'));
        row.appendChild(head);

        var actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.appendChild(
          button(user.suspended ? 'Unsuspend' : 'Suspend', 'secondary', function (node) {
            node.disabled = true;
            api('/api/admin/users/' + user.id, {
              method: 'PATCH',
              body: { suspended: !user.suspended },
            })
              .then(function () {
                status('ok', 'Updated ' + user.label + '.');
                return loadPeople();
              })
              .catch(function (error) {
                node.disabled = false;
                handle(error);
              });
          }),
        );
        row.appendChild(actions);
        list.appendChild(row);
      });
    });
  }

  // -------------------------------------------------------------------- tabs

  var PANELS = ['businesses', 'reviews', 'people', 'account'];

  function showPanel(name) {
    PANELS.forEach(function (panel) {
      el('panel-' + panel).classList.toggle('hidden', panel !== name);
      el('tab-' + panel).setAttribute('aria-selected', String(panel === name));
    });
    if (name === 'reviews') loadReviews(null, null).catch(handle);
    if (name === 'people') loadPeople().catch(handle);
    if (name === 'businesses') loadBusinesses().catch(handle);
  }

  PANELS.forEach(function (panel) {
    el('tab-' + panel).addEventListener('click', function () {
      status('', '');
      showPanel(panel);
    });
  });

  // ------------------------------------------------------------------- session

  var AUTH_PANES = ['signin', 'signup', 'forgot', 'reset'];
  var account = null;

  function showAuthPane(name) {
    AUTH_PANES.forEach(function (pane) {
      el('pane-' + pane).classList.toggle('hidden', pane !== name);
    });
    el('auth').classList.remove('hidden');
    el('console').classList.add('hidden');
    var first = el('pane-' + name).querySelector('input');
    if (first) first.focus();
  }

  function showConsole(owner) {
    account = owner;
    el('auth').classList.add('hidden');
    el('console').classList.remove('hidden');
    el('account-email').textContent = owner.email;
    el('account-role').textContent = owner.isAdmin
      ? 'Platform admin - you see every business on this server'
      : 'Owner - you see the businesses you created';
    // The reviewer list is platform-wide, so it is not an owner's business.
    el('tab-people').classList.toggle('hidden', !owner.isAdmin);
    status('', '');
    showPanel('businesses');
  }

  // Kept for the 401 path elsewhere in this file: any request that comes back
  // unauthorised drops us here rather than leaving a dead console on screen.
  function signOut(message) {
    account = null;
    el('console').classList.add('hidden');
    showAuthPane('signin');
    if (message) status('error', message);
  }

  function describe(error) {
    return error && error.message ? error.message : 'Something went wrong. Please try again.';
  }

  // Each form: disable the button, call the endpoint, re-enable whatever
  // happens. Without the re-enable a failed attempt leaves a dead button.
  function submitting(buttonId, working, run) {
    var submit = el(buttonId);
    submit.disabled = true;
    status('working', working);
    return run()
      .catch(function (error) {
        status('error', describe(error));
      })
      .then(function () {
        submit.disabled = false;
      });
  }

  document.querySelectorAll('[data-go]').forEach(function (anchor) {
    anchor.addEventListener('click', function (event) {
      event.preventDefault();
      status('', '');
      showAuthPane(anchor.dataset.go);
    });
  });

  el('pane-signin').addEventListener('submit', function (event) {
    event.preventDefault();
    submitting('signin-button', 'Checking.', function () {
      return api('/api/owner/login', {
        method: 'POST',
        body: { email: el('signin-email').value, password: el('signin-password').value },
      }).then(function (data) {
        el('signin-password').value = '';
        showConsole(data.owner);
      });
    });
  });

  el('pane-signup').addEventListener('submit', function (event) {
    event.preventDefault();
    submitting('signup-button', 'Creating your account.', function () {
      return api('/api/owner/signup', {
        method: 'POST',
        body: {
          name: el('signup-name').value,
          email: el('signup-email').value,
          password: el('signup-password').value,
        },
      }).then(function (data) {
        el('signup-password').value = '';
        showConsole(data.owner);
        if (window.toast) window.toast('Welcome. Add your first business below.');
      });
    });
  });

  el('pane-forgot').addEventListener('submit', function (event) {
    event.preventDefault();
    submitting('forgot-button', 'Sending a code.', function () {
      var email = el('forgot-email').value;
      return api('/api/owner/forgot', { method: 'POST', body: { email: email } }).then(function () {
        el('reset-email').value = email;
        showAuthPane('reset');
        // Says "if", not "we sent": the server answers the same way whether or
        // not that address has an account, and this message has to match.
        status('ok', 'If that address has an account, a code is on its way.');
      });
    });
  });

  el('pane-reset').addEventListener('submit', function (event) {
    event.preventDefault();
    submitting('reset-button', 'Setting your new password.', function () {
      return api('/api/owner/reset', {
        method: 'POST',
        body: {
          email: el('reset-email').value,
          code: el('reset-code').value,
          newPassword: el('reset-password').value,
        },
      }).then(function (data) {
        el('reset-code').value = '';
        el('reset-password').value = '';
        showConsole(data.owner);
        if (window.toast) window.toast('Your password has been changed.');
      });
    });
  });

  el('change-password').addEventListener('submit', function (event) {
    event.preventDefault();
    submitting('change-password-button', 'Changing your password.', function () {
      return api('/api/owner/password', {
        method: 'POST',
        body: {
          currentPassword: el('current-password').value,
          newPassword: el('new-password').value,
        },
      }).then(function () {
        el('current-password').value = '';
        el('new-password').value = '';
        status('ok', 'Your password has been changed. Other browsers have been signed out.');
      });
    });
  });

  el('sign-out').addEventListener('click', function () {
    api('/api/owner/logout', { method: 'POST' })
      .catch(function () {
        /* The cookie is gone either way; nothing useful to say. */
      })
      .then(function () {
        signOut('');
        if (window.toast) window.toast('You have signed out.');
      });
  });

  // What the page opens on depends on what the server says exists: a console
  // if this browser is already signed in, the sign-up form on an install with
  // no accounts yet, and the sign-in form otherwise.
  api('/api/owner/me')
    .then(function (data) {
      el('forgot-wrap').classList.toggle('hidden', !data.canResetPassword);
      if (data.owner) return showConsole(data.owner);
      if (data.setupNeeded) {
        el('signup-heading').textContent = 'Create the first account';
        el('signup-note').textContent =
          'Nobody has an account on this server yet, so this one runs it: you will see every business and every reviewer.';
        return showAuthPane('signup');
      }
      return showAuthPane('signin');
    })
    .catch(function () {
      showAuthPane('signin');
      status('error', 'Could not reach the server. Please reload.');
    });
})();
