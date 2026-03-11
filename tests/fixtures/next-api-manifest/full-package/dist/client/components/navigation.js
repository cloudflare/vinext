"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
0 && (module.exports = {
    ReadonlyURLSearchParams: null,
    redirect: null,
    usePathname: null,
    useRouter: null,
    useSearchParams: null
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    ReadonlyURLSearchParams: function() {
        return ReadonlyURLSearchParams;
    },
    redirect: function() {
        return redirect;
    },
    usePathname: function() {
        return usePathname;
    },
    useRouter: function() {
        return useRouter;
    },
    useSearchParams: function() {
        return useSearchParams;
    }
});
const ReadonlyURLSearchParams = {};
const redirect = () => {};
const usePathname = () => "/";
const useRouter = () => ({});
const useSearchParams = () => new URLSearchParams();
