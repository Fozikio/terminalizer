/**
 * Render
 * Render a recording file as an animated gif image
 *
 * @author Mohammad Fares <faressoft.com@gmail.com>
 */

const tmp = require('tmp');

tmp.setGracefulCleanup();

/**
 * Create a progress bar for processing frames
 *
 * @param  {String}      operation   a name for the operation
 * @param  {Number}      framesCount
 * @return {ProgressBar}
 */
function getProgressBar(operation, framesCount) {
  return new di.ProgressBar(
    operation +
      " " +
      di.chalk.magenta("frame :current/:total") +
      " :percent [:bar] :etas",
    {
      width: 30,
      total: framesCount,
    }
  );
}

/**
 * Write the recording data into render/data.json
 *
 * @param  {Object}  recordingFile
 * @return {Promise}
 */
function writeRecordingData(recordingFile) {
  return new Promise(function (resolve, reject) {
    // Write the data into data.json file in the root path of the app
    di.fs.writeFile(
      di.path.join(ROOT_PATH, "render/data.json"),
      JSON.stringify(recordingFile.json),
      "utf8",
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve();
      }
    );
  });
}

/**
 * Parse a PNG Buffer into a pngjs PNG object
 *
 * @param  {Buffer}  buffer
 * @return {Promise} resolve with the parsed PNG image
 */
function parsePNGBuffer(buffer) {
  return new Promise(function (resolve, reject) {
    new di.PNG().parse(buffer, function (error, data) {
      if (error) {
        return reject(error);
      }

      resolve(data);
    });
  });
}

/**
 * Read and parse a PNG image file
 *
 * @param  {String}  path the absolute path of the image
 * @return {Promise} resolve with the parsed PNG image
 */
function loadPNG(path) {
  return new Promise(function (resolve, reject) {
    di.fs.readFile(path, function (error, imageData) {
      if (error) {
        return reject(error);
      }

      new di.PNG().parse(imageData, function (error, data) {
        if (error) {
          return reject(error);
        }

        resolve(data);
      });
    });
  });
}

/**
 * Render the frames into PNG images using Playwright
 *
 * @param  {Array}   records [{delay, content}, ...]
 * @param  {Object}  options {step}
 * @return {Promise} resolves with an Array of PNG Buffers indexed by record position (null for skipped frames)
 */
async function renderFrames(records, options) {
  var framesCount = records.length;
  var start = Date.now();

  var progressBar = getProgressBar(
    "Rendering",
    Math.ceil(framesCount / options.step)
  );

  var { chromium } = di.playwright;
  var browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });

  // Serve the render directory via HTTP to avoid file:// CORS issues with Ajax
  var http = require('http');
  var handler = require('serve-handler');
  var renderDir = di.path.join(ROOT_PATH, 'render');

  var server = await new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      return handler(req, res, { public: renderDir });
    });
    srv.listen(0, '127.0.0.1', function () {
      resolve(srv);
    });
  });
  var port = server.address().port;

  try {
    var page = await browser.newPage();

    // Viewport large enough for any terminal size
    await page.setViewportSize({ width: 8000, height: 8000 });

    // Capture console logs for debugging
    page.on('console', function (msg) { console.error('[browser]', msg.text()); });
    page.on('pageerror', function (err) { console.error('[browser error]', err.message); });

    // Load the renderer HTML via HTTP (avoids file:// CORS issues with data.json)
    await page.goto('http://127.0.0.1:' + port + '/index.html');

    // Wait for the Playwright frame API to be ready (set by app.js once terminal reset is done)
    console.error('[render] Waiting for terminal to initialize...');
    await page.waitForFunction('window.__terminizerReady === true', { timeout: 30000 });
    console.error('[render] Terminal ready');

    var frameCount = await page.evaluate('window.getFrameCount()');
    var terminalRect = await page.evaluate('window.getTerminalRect()');
    console.error('[render] Frames: ' + frameCount + ', Rect: ' + JSON.stringify(terminalRect));

    // Array indexed by record position; null for skipped (step) frames
    var frameBuffers = new Array(framesCount).fill(null);

    var stepsCounter = 0;

    for (var i = 0; i < frameCount; i++) {
      if (stepsCounter !== 0) {
        stepsCounter = (stepsCounter + 1) % options.step;
        continue;
      }

      stepsCounter = (stepsCounter + 1) % options.step;

      // Ask the player to render this frame (with timeout fallback)
      if (i === 0 || i % 20 === 0) console.error('[render] Frame ' + i + '/' + frameCount);
      await page.evaluate('Promise.race([window.renderFrame(' + i + '), new Promise(r => setTimeout(r, 2000))])');

      // Capture only the terminal element area — returns a Buffer
      var screenshot = await page.screenshot({
        clip: terminalRect,
        type: 'png',
      });

      frameBuffers[i] = screenshot;
      progressBar.tick();
    }

    console.log(di.chalk.green('[render] Process successfully completed in ' + (Date.now() - start) + 'ms.'));

    return frameBuffers;
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Get the dimensions from the first non-null frame Buffer
 *
 * @param  {Array}   frameBuffers array of PNG Buffers (may contain nulls for skipped frames)
 * @return {Promise} resolves with {width, height}
 */
function getFrameDimensions(frameBuffers) {
  // Find the first captured frame
  var firstBuffer = frameBuffers.find(function (b) { return b !== null; });

  if (!firstBuffer) {
    return Promise.reject(new Error('No frames were rendered'));
  }

  return parsePNGBuffer(firstBuffer).then(function (png) {
    return {
      width: png.width,
      height: png.height,
    };
  });
}

/**
 * Merge the rendered frames into an animated GIF image
 *
 * @param  {Array}   records         [{delay, content}, ...]
 * @param  {Object}  options         {quality, repeat, step, outputFile}
 * @param  {Array}   frameBuffers    array of PNG Buffers indexed by record position (null for skipped)
 * @param  {Object}  frameDimensions {width, height}
 * @return {Promise}
 */
function mergeFrames(records, options, frameBuffers, frameDimensions) {
  return new Promise(function (resolve, reject) {
    // The number of frames
    var framesCount = records.length;

    // Track execution time
    var start = Date.now();

    // Used for the step option
    var stepsCounter = 0;

    // Create a progress bar
    var progressBar = getProgressBar(
      "Merging",
      Math.ceil(framesCount / options.step)
    );

    // gifenc API
    var GIFEncoder = di.gifenc.GIFEncoder;
    var quantize = di.gifenc.quantize;
    var applyPalette = di.gifenc.applyPalette;

    // Map quality (1-100) to palette size (8-256).
    // Higher quality = more colors = larger palette.
    var paletteSize = Math.max(8, Math.round((options.quality / 100) * 256));
    // Round down to nearest power of 2 (gifenc requires power-of-2 palette sizes)
    paletteSize = Math.pow(2, Math.floor(Math.log2(paletteSize)));

    // repeat: -1 = play once (0 loops), 0 = loop forever, N = loop N times
    var repeat = options.repeat === -1 ? -1 : options.repeat;

    var gif = GIFEncoder();

    di.async.eachOfSeries(
      records,
      function (frame, index, callback) {
        if (stepsCounter != 0) {
          stepsCounter = (stepsCounter + 1) % options.step;
          return callback();
        }

        stepsCounter = (stepsCounter + 1) % options.step;

        var frameBuffer = frameBuffers[index];

        // Parse from Buffer (in-memory, no disk read needed)
        parsePNGBuffer(frameBuffer)
          .then(function (png) {
            progressBar.tick();

            // The delay of the next frame (% wraps last frame back to first)
            var delay = records[(index + 1) % framesCount].delay;

            // quantize expects a flat Uint8Array of RGBA pixels
            var rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
            var palette = quantize(rgba, paletteSize);
            var indexed = applyPalette(rgba, palette);

            gif.writeFrame(indexed, frameDimensions.width, frameDimensions.height, {
              palette: palette,
              delay: delay,
              repeat: repeat,
            });

            // Next
            callback();
          })
          .catch(function (error) {
            callback(error);
          });
      },
      function (error) {
        if (error) {
          return reject(error);
        }

        gif.finish();

        // Write the GIF bytes to disk
        di.fs.writeFileSync(options.outputFile, Buffer.from(gif.bytes()));

        // Finish
        console.log(di.chalk.green('[merge] Process successfully completed in ' + (Date.now() - start) + 'ms.'));
        resolve();
      }
    );
  });
}

/**
 * Executed after the command completes its task
 *
 * @param {String} outputFile the path of the rendered image
 */
function done(outputFile) {
  console.log("\n" + di.chalk.green("Successfully Rendered"));
  console.log("The animated GIF image is saved into the file:");
  console.log(di.chalk.magenta(outputFile));
  process.exit();
}

/**
 * The command's main function
 *
 * @param {Object} argv
 */
function command(argv) {
  // Frames
  var records = argv.recordingFile.json.records;
  var config = argv.recordingFile.json.config;

  // The path of the output file
  var outputFile = di.utility.resolveFilePath(
    "render" + Date.now(),
    "gif"
  );

  // For adjusting (calculating) the frames delays
  var adjustFramesDelaysOptions = {
    frameDelay: config.frameDelay,
    maxIdleTime: config.maxIdleTime,
  };

  // For rendering the frames into PNG images
  var renderingOptions = {
    step: argv.step,
  };

  // For merging the rendered frames into an animated GIF image
  var mergingOptions = {
    quality: config.quality,
    repeat: config.repeat,
    step: argv.step,
    outputFile: outputFile,
  };

  // Overwrite the quality of the rendered image
  if (argv.quality) {
    mergingOptions.quality = argv.quality;
  }

  // Overwrite the outputFile of the rendered image
  if (argv.output) {
    outputFile = argv.output;
    mergingOptions.outputFile = argv.output;
  }

  // frameBuffers is produced by renderFrames and threaded through the waterfall
  var frameBuffers = null;

  // Tasks
  di.asyncPromises
    .waterfall([
      // Write the recording data into render/data.json (needed by the browser renderer)
      di._.partial(writeRecordingData, argv.recordingFile),

      // Render the frames into PNG Buffers via Playwright
      function () {
        return renderFrames(records, renderingOptions).then(function (buffers) {
          frameBuffers = buffers;
        });
      },

      // Adjust frames delays
      di._.partial(
        di.commands.play.adjustFramesDelays,
        records,
        adjustFramesDelaysOptions
      ),

      // Get the dimensions of the first rendered frame Buffer
      function () {
        return getFrameDimensions(frameBuffers);
      },

      // Merge the rendered frames into an animated GIF image
      function (frameDimensions) {
        return mergeFrames(records, mergingOptions, frameBuffers, frameDimensions);
      },
    ])
    .then(function () {
      done(outputFile);
    })
    .catch(di.errorHandler);
}

////////////////////////////////////////////////////
// Command Definition //////////////////////////////
////////////////////////////////////////////////////

/**
 * Command's usage
 * @type {String}
 */
module.exports.command = "render <recordingFile>";

/**
 * Command's description
 * @type {String}
 */
module.exports.describe = "Render a recording file as an animated gif image";

/**
 * Command's handler function
 * @type {Function}
 */
module.exports.handler = command;

/**
 * Builder
 *
 * @param {Object} yargs
 */
module.exports.builder = function (yargs) {
  // Define the recordingFile argument
  yargs.positional("recordingFile", {
    describe: "The recording file",
    type: "string",
    coerce: di.utility.loadYAML,
  });

  // Define the output option
  yargs.option("o", {
    alias: "output",
    type: "string",
    describe: "A name for the output file",
    requiresArg: true,
    coerce: di._.partial(di.utility.resolveFilePath, di._, "gif"),
  });

  // Define the quality option
  yargs.option("q", {
    alias: "quality",
    type: "number",
    describe: "The quality of the rendered image (1 - 100)",
    requiresArg: true,
  });

  // Define the quality option
  yargs.option("s", {
    alias: "step",
    type: "number",
    describe: "To reduce the number of rendered frames (step > 1)",
    requiresArg: true,
    default: 1,
  });
};
