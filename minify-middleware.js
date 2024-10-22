const { minify } = require('html-minifier');

function minifyHTMLContent(content) {
    return minify(content, {
        removeAttributeQuotes: true,
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true
    });
}

function minifyHTMLMiddleware(req, res, next) {
    const originalRender = res.render;
    res.render = function(view, options, callback) {
        originalRender.call(res, view, options, function(err, html) {
            if (err) {
                return callback ? callback(err) : next(err);
            }
            const minifiedHtml = minifyHTMLContent(html);
            callback ? callback(null, minifiedHtml) : res.send(minifiedHtml);
        });
    };
    next();
}

module.exports = minifyHTMLMiddleware;