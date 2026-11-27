const config = { require: "require" };
// `require` is only a property name here: this error must not be retried as CommonJS.
throw new ReferenceError(`${config.require} is not defined in ES module scope`);
