// middleware/validate.js
// Generic request-body validator. Routes previously did ad-hoc `if (!field)` checks
// with no shared rules for types, ranges, or formats (e.g. /register never checked
// password length or email shape; numeric fields could be handed strings, negatives,
// or NaN and would only fail, confusingly, once they hit a SQL type error).
function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const firstIssue = result.error.issues[0];
            const field = firstIssue.path.join('.') || 'body';
            return res.status(400).json({ error: `${field}: ${firstIssue.message}` });
        }
        req.body = result.data;
        next();
    };
}

module.exports = { validateBody };
