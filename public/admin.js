/* ReviewQR admin console. The password is held in sessionStorage for this tab
   and sent as the x-admin-token header. All text is rendered with textContent. */
(function () {
  'use strict';

  var KEY = 'reviewqr:admin-token';
  var token = '';

  var el = function (id) {
    return document.getElementById(id);
  };

  function status(kind, message) {
    var node = el('status');
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = message || '';
  }

  function api(path, options) {
    options = options || {};
    var headers = { 'x-admin-token': token };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
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
    if (error.status === 401) {
      signOut('That password was not accepted. Please sign in again.');
      return;
    }
    status('error', error.message);
  }

  // -------------------------------------------------------------- businesses

  function loadBusinesses() {
    return api('/api/admin/businesses').then(function (data) {
      var list = el('business-list');
      list.textContent = '';
      el('business-empty').classList.toggle('hidden', data.businesses.length > 0);

      data.businesses.forEach(function (business) {
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
    });
  }

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

  var PANELS = ['businesses', 'reviews', 'people'];

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

  function signOut(message) {
    token = '';
    try {
      sessionStorage.removeItem(KEY);
    } catch (error) {
      /* ignore */
    }
    el('console').classList.add('hidden');
    el('sign-in').classList.remove('hidden');
    el('password').value = '';
    if (message) status('error', message);
    el('password').focus();
  }

  function signIn(candidate) {
    token = candidate;
    return api('/api/admin/businesses').then(function () {
      try {
        sessionStorage.setItem(KEY, candidate);
      } catch (error) {
        /* ignore */
      }
      el('sign-in').classList.add('hidden');
      el('console').classList.remove('hidden');
      status('', '');
      showPanel('businesses');
    });
  }

  el('sign-in').addEventListener('submit', function (event) {
    event.preventDefault();
    var candidate = el('password').value;
    if (!candidate) {
      status('error', 'Please enter the admin password.');
      return;
    }
    var submit = el('sign-in-button');
    submit.disabled = true;
    status('working', 'Checking the password.');
    signIn(candidate)
      .catch(function (error) {
        token = '';
        status('error', error.status === 401 ? 'That password was not accepted.' : error.message);
      })
      .then(function () {
        submit.disabled = false;
      });
  });

  el('sign-out').addEventListener('click', function () {
    signOut('You have signed out.');
  });

  var saved = '';
  try {
    saved = sessionStorage.getItem(KEY) || '';
  } catch (error) {
    saved = '';
  }
  if (saved) {
    signIn(saved).catch(function () {
      signOut('Please sign in again.');
    });
  } else {
    el('sign-in').classList.remove('hidden');
  }
})();
