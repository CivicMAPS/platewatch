package au.techcorp.platewatch;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Plate reading clean-up for the native patrol reader. Mirrors canonicalPlate, isAutoCapturePlate
 * and isPlateVariant in src/lib/plate.ts; both run the shared vectors in
 * tests/fixtures/plate-readings.tsv (PlateRulesTest here, plateRules.test.ts there).
 * Plain Java with no Android dependencies, so it runs as a local unit test.
 */
final class PlateRules {
    private PlateRules() {}

    /** General-issue formats (D digit, L letter): Victoria first, then NSW, QLD, WA, SA. */
    static final String[] FORMATS = {"DLLDLL","LLLDDD","LLDDLL","LLLDDL","DDDLLL","DLLLDDD","LDDDLLL"};
    private static final Map<Character,Character> LETTER_AS_DIGIT = new HashMap<>();
    private static final Map<Character,Character> LOOSE = new HashMap<>();
    private static final Set<Character> EMBLEM = Set.of('X','V','Y');
    private static final Set<Character> EDGE = Set.of('E','I','L','J','1');
    private static final int MAX_FIXES = 2;
    static {
        String[][] asDigit = {{"O","0"},{"Q","0"},{"D","0"},{"I","1"},{"L","1"},{"Z","2"},{"S","5"},{"G","6"},{"B","8"},{"T","7"}};
        for (String[] p:asDigit) LETTER_AS_DIGIT.put(p[0].charAt(0),p[1].charAt(0));
        // looseKey in plate.ts
        // Look-alike classes (WF-S28 OQ28-1): adds R·P (owner) and A·4, F·E, N·M (proposed).
        String[][] loose = {{"O","0"},{"Q","0"},{"I","1"},{"D","0"},{"B","8"},{"S","5"},{"Z","2"},{"G","6"},{"L","1"},{"T","7"},{"U","V"},{"P","R"},{"4","A"},{"E","F"},{"M","N"}};
        for (String[] p:loose) LOOSE.put(p[0].charAt(0),p[1].charAt(0));
    }

    static String normalise(String input) {
        return input==null ? "" : input.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]","");
    }

    private static boolean isDigit(char c) { return c>='0' && c<='9'; }

    private static String fit(String p,int maxFixes) {
        String best = null;
        int bestFixes = Integer.MAX_VALUE;
        for (String format:FORMATS) {
            if (format.length()!=p.length()) continue;
            StringBuilder out = new StringBuilder();
            int fixes = 0;
            for (int i=0;i<p.length() && out.length()==i;i++) {
                char c = p.charAt(i);
                if (format.charAt(i)=='L') { if (!isDigit(c)) out.append(c); }
                else if (isDigit(c)) out.append(c);
                else if (LETTER_AS_DIGIT.containsKey(c)) { out.append(LETTER_AS_DIGIT.get(c)); fixes++; }
            }
            // Ties go to the earlier (local) format.
            if (out.length()==p.length() && fixes<=maxFixes && fixes<bestFixes) { best = out.toString(); bestFixes = fixes; }
        }
        return best;
    }

    /** See canonicalPlate in src/lib/plate.ts. */
    static String canonical(String input) {
        String p = normalise(input);
        if (p.length()<5 || p.length()>8) return p;
        String direct = fit(p,MAX_FIXES);
        if (direct!=null) return direct;
        if (p.length()==7 && EMBLEM.contains(p.charAt(3))) {
            String f = fit(p.substring(0,3)+p.substring(4),0);
            if (f!=null) return f;
        }
        Set<String> trimmed = new HashSet<>();
        if (EDGE.contains(p.charAt(0))) { String f = fit(p.substring(1),0); if (f!=null) trimmed.add(f); }
        if (EDGE.contains(p.charAt(p.length()-1))) { String f = fit(p.substring(0,p.length()-1),0); if (f!=null) trimmed.add(f); }
        return trimmed.size()==1 ? trimmed.iterator().next() : p;
    }

    /** 4–8 characters with at least one letter and one digit. */
    static boolean autoCapture(String plate) {
        return plate!=null && plate.matches("(?=.*\\d)(?=.*[A-Z])[A-Z0-9]{4,8}");
    }

    private static String looseKey(String p) {
        StringBuilder out = new StringBuilder();
        for (char c:p.toCharArray()) out.append(LOOSE.getOrDefault(c,c));
        return out.toString();
    }

    /** comparePlates(a, b) === 'possible' in src/lib/plate.ts: equal after the look-alike classes, not exactly equal. */
    static boolean lookalike(String a,String b) {
        String x = normalise(a), y = normalise(b);
        return !x.equals(y) && looseKey(x).equals(looseKey(y));
    }

    /** See isPlateVariant in src/lib/plate.ts. */
    static boolean variant(String a,String b) {
        Set<String> xs = new LinkedHashSet<>(); xs.add(normalise(a)); xs.add(canonical(a));
        Set<String> ys = new LinkedHashSet<>(); ys.add(normalise(b)); ys.add(canonical(b));
        for (String x:xs) for (String y:ys) if (close(x,y)) return true;
        return false;
    }

    private static boolean close(String x,String y) {
        if (x.equals(y) || looseKey(x).equals(looseKey(y))) return true;
        if (Math.min(x.length(),y.length())<5) return false;
        if (x.length()==y.length()) {
            int diff = 0;
            for (int i=0;i<x.length();i++) if (x.charAt(i)!=y.charAt(i)) diff++;
            return diff<=1;
        }
        if (Math.abs(x.length()-y.length())!=1) return false;
        String lng = x.length()>y.length() ? x : y, shrt = x.length()>y.length() ? y : x;
        for (int i=0;i<lng.length();i++) if ((lng.substring(0,i)+lng.substring(i+1)).equals(shrt)) return true;
        return false;
    }
}
