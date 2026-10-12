/* The printable poster. Everything on screen except .poster is hidden at print
   time by the @media print rules in style.css. */
(function () {
  'use strict';

  var el = function (id) {
    return document.getElementById(id);
  };

  // /b/<slug>/poster - the slug is the second segment, not the last.
  var parts = window.location.pathname.split('/').filter(Boolean);
  var slug = parts.length >= 2 ? parts[1] : '';

  function fail(message) {
    var node = el('poster-error');
    node.textContent = message;
    node.classList.remove('hidden');
  }

  if (!slug) {
    fail('No business in the address. Open this from the admin console.');
    return;
  }

  fetch('/api/b/' + encodeURIComponent(slug), { credentials: 'same-origin' })
    .then(function (response) {
      if (!response.ok) throw new Error('That business could not be found.');
      return response.json();
    })
    .then(function (data) {
      var business = data.business;
      el('out-name').textContent = business.name;
      // SVG, not PNG: a poster gets printed, and a raster code at A4 is the
      // one thing guaranteed to scan badly.
      el('out-qr').src = '/api/b/' + encodeURIComponent(slug) + '/qr.svg';
      el('out-qr').alt = 'QR code linking to reviews for ' + business.name;
      el('out-url').textContent = window.location.host + '/b/' + slug;
      document.title = 'Poster - ' + business.name;
    })
    .catch(function (error) {
      fail(error.message || 'Could not load that business.');
    });

  el('size').addEventListener('change', function (event) {
    el('poster').className = 'poster ' + event.target.value;
  });

  // Live, because the point of the preview is to see it before wasting paper.
  el('headline').addEventListener('input', function (event) {
    el('out-headline').textContent = event.target.value;
  });

  el('cta').addEventListener('input', function (event) {
    el('out-cta').textContent = event.target.value;
  });

  el('print').addEventListener('click', function () {
    window.print();
  });
})();
