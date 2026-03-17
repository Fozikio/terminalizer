/**
 * Terminalizer
 *
 * @author Mohammad Fares <faressoft.com@gmail.com>
 */

import async from 'async';
import 'terminalizer-player';

// Styles
import '../css/app.css';
import 'terminalizer-player/dist/css/terminalizer.min.css';
import 'xterm/dist/xterm.css';

/**
 * Whether we are running under Playwright (no Electron IPC available)
 * @type {Boolean}
 */
var isPlaywright = typeof window.app === 'undefined';

/**
 * A callback function for the event:
 * When the document is loaded
 */
$(document).ready(async () => {
  // Initialize the terminalizer plugin
  $('#terminal').terminalizer({
    recordingFile: 'data.json',
    autoplay: true,
    controls: false,
  });

  /**
   * A callback function for the event:
   * When the terminal playing is started
   */
  $('#terminal').one('playingStarted', function () {
    var terminalizer = $('#terminal').data('terminalizer');

    // Pause the playing
    terminalizer.pause();
  });

  /**
   * A callback function for the event:
   * When the terminal playing is paused
   */
  $('#terminal').one('playingPaused', function () {
    var terminalizer = $('#terminal').data('terminalizer');

    // Reset the terminal
    terminalizer._terminal.reset();

    // When the terminal's reset is done
    $('#terminal').one('rendered', function () {
      if (isPlaywright) {
        // Playwright mode: expose frame control API, signal ready
        exposePlaywrightAPI();
        window.__terminizerReady = true;
      } else {
        // Electron mode: run the original capture loop
        render();
      }
    });
  });
});

/**
 * Expose frame control API on window for Playwright to call
 */
function exposePlaywrightAPI() {
  var terminalizer = $('#terminal').data('terminalizer');

  /**
   * Render a specific frame index
   * Returns a Promise that resolves when the frame is rendered
   *
   * @param {Number} frameIndex
   * @return {Promise}
   */
  window.renderFrame = function (frameIndex) {
    return new Promise(function (resolve) {
      terminalizer._renderFrame(frameIndex, true, resolve);
    });
  };

  /**
   * Get the total number of frames
   *
   * @return {Number}
   */
  window.getFrameCount = function () {
    return terminalizer.getFramesCount();
  };

  /**
   * Get the terminal element bounding rect
   *
   * @return {Object} {x, y, width, height}
   */
  window.getTerminalRect = function () {
    var el = document.getElementById('terminal');
    var rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
}

/**
 * Render each frame and capture it (Electron mode only)
 */
function render() {
  var terminalizer = $('#terminal').data('terminalizer');
  var framesCount = terminalizer.getFramesCount();

  // Foreach frame
  async.timesSeries(
    framesCount,
    function (frameIndex, next) {
      terminalizer._renderFrame(frameIndex, true, function () {
        captureElectron(frameIndex, next);
      });
    },
    function (error) {
      if (error) {
        throw new Error(error);
      }

      app.close();
    }
  );
}

/**
 * Capture the current frame via Electron IPC
 *
 * @param {Number}   frameIndex
 * @param {Function} callback
 */
function captureElectron(frameIndex, callback) {
  var width = $('#terminal').width();
  var height = $('#terminal').height();
  var captureRect = { x: 0, y: 0, width: width, height: height };

  app
    .capturePage(captureRect, frameIndex)
    .then(callback)
    .catch((err) => {
      throw err;
    });
}
