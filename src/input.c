#include "input.h"
#include "protocol.h"
#include "util.h"

#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <string.h>
#include <ctype.h>

/* JS KeyboardEvent.code -> X11 keysym 名 */
typedef struct
{
    const char *js;
    const char *x;
} keymap_t;

static const keymap_t g_keymap[] = {
    {"ControlLeft", "Control_L"},
    {"ControlRight", "Control_R"},
    {"ShiftLeft", "Shift_L"},
    {"ShiftRight", "Shift_R"},
    {"AltLeft", "Alt_L"},
    {"AltRight", "Alt_R"},
    {"MetaLeft", "Super_L"},
    {"MetaRight", "Super_R"},
    {"CapsLock", "Caps_Lock"},
    {"Space", "space"},
    {"Enter", "Return"},
    {"Backspace", "BackSpace"},
    {"Tab", "Tab"},
    {"Escape", "Escape"},
    {"Delete", "Delete"},
    {"ArrowUp", "Up"},
    {"ArrowDown", "Down"},
    {"ArrowLeft", "Left"},
    {"ArrowRight", "Right"},
    {"Home", "Home"},
    {"End", "End"},
    {"PageUp", "Prior"},
    {"PageDown", "Next"},
    {"Insert", "Insert"},
    {"PrintScreen", "Print"},
    {"ContextMenu", "Menu"},
    {"F1", "F1"},
    {"F2", "F2"},
    {"F3", "F3"},
    {"F4", "F4"},
    {"F5", "F5"},
    {"F6", "F6"},
    {"F7", "F7"},
    {"F8", "F8"},
    {"F9", "F9"},
    {"F10", "F10"},
    {"F11", "F11"},
    {"F12", "F12"},
    {"Minus", "minus"},
    {"Equal", "equal"},
    {"BracketLeft", "bracketleft"},
    {"BracketRight", "bracketright"},
    {"Backslash", "backslash"},
    {"Semicolon", "semicolon"},
    {"Quote", "apostrophe"},
    {"Comma", "comma"},
    {"Period", "period"},
    {"Slash", "slash"},
    {"Backquote", "grave"},
    {"IntlBackslash", "backslash"},
    {"NumLock", "Num_Lock"},
    {"Numpad0", "KP_0"},
    {"Numpad1", "KP_1"},
    {"Numpad2", "KP_2"},
    {"Numpad3", "KP_3"},
    {"Numpad4", "KP_4"},
    {"Numpad5", "KP_5"},
    {"Numpad6", "KP_6"},
    {"Numpad7", "KP_7"},
    {"Numpad8", "KP_8"},
    {"Numpad9", "KP_9"},
    {"NumpadAdd", "KP_Add"},
    {"NumpadSubtract", "KP_Subtract"},
    {"NumpadMultiply", "KP_Multiply"},
    {"NumpadDivide", "KP_Divide"},
    {"NumpadEnter", "KP_Enter"},
    {"NumpadDecimal", "KP_Decimal"},
};

static KeySym keysym_from_code(const char *code)
{
    if (!code || !code[0])
        return NoSymbol;
    /* KeyA -> 'A'，Digit1 -> '1' */
    if (strncmp(code, "Key", 3) == 0 && strlen(code) == 4)
        return (KeySym)(unsigned char)toupper((unsigned char)code[3]);
    if (strncmp(code, "Digit", 5) == 0 && strlen(code) == 6)
        return (KeySym)(unsigned char)code[5];
    for (size_t i = 0; i < sizeof(g_keymap) / sizeof(g_keymap[0]); i++)
        if (strcmp(g_keymap[i].js, code) == 0)
            return XStringToKeysym(g_keymap[i].x);
    return XStringToKeysym(code);
}

void input_handle_mouse(runtime *rt, const uint8_t *data, size_t len)
{
    if (len < 6)
        return;
    int flags = data[1];
    int x = data[2] | (data[3] << 8);
    int y = data[4] | (data[5] << 8);

    pthread_mutex_lock(&rt->xlock);
    if (flags & MOUSE_FLAG_BUTTON)
    {
        if (len < 8)
        {
            pthread_mutex_unlock(&rt->xlock);
            return;
        }
        int button = data[6];
        int pressed = data[7];
        XTestFakeMotionEvent(rt->dpy, 0, x, y, 0);
        XTestFakeButtonEvent(rt->dpy, button, pressed, 0);
    }
    else
    {
        XTestFakeMotionEvent(rt->dpy, 0, x, y, 0);
    }
    XFlush(rt->dpy);
    pthread_mutex_unlock(&rt->xlock);
}

void input_handle_key(runtime *rt, const uint8_t *data, size_t len)
{
    if (len < 2)
        return;
    int pressed = data[1];
    char code[64];
    size_t cl = len - 2;
    if (cl >= sizeof code)
        cl = sizeof code - 1;
    memcpy(code, data + 2, cl);
    code[cl] = 0;

    KeySym ks = keysym_from_code(code);
    if (ks == NoSymbol)
        return;
    KeyCode kc = XKeysymToKeycode(rt->dpy, ks);
    if (!kc)
        return;

    pthread_mutex_lock(&rt->xlock);
    XTestFakeKeyEvent(rt->dpy, kc, pressed, 0);
    XFlush(rt->dpy);
    pthread_mutex_unlock(&rt->xlock);
}
