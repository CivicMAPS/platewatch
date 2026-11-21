package au.techcorp.platewatch;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Rational;
import android.util.Size;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.Surface;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.OptIn;
import androidx.camera.camera2.interop.Camera2CameraControl;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.CaptureRequestOptions;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.*;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.util.*;

/**
 * Native camera screen for walking and vehicle patrol, plus ML Kit text reading for stills.
 *
 * Capture modes:
 *  - Multi: every frame is read; a plate seen in consecutive frames is captured automatically.
 *    Only text the officer can see counts (preview and analysis share one ViewPort); in walking
 *    patrol it must also sit in the plate guide. Readings are cleaned up and filtered by
 *    PlateRules, and a near-duplicate of a recent capture (1UR6YF / 1UP6YF) is not captured
 *    again: it is reported to the web layer as an alternative reading ("variant" event).
 *  - Single: frames are only read when the officer presses the shutter (saves battery).
 * The shutter works in both modes. Every capture flashes the screen and vibrates.
 */
@CapacitorPlugin(name="PatrolCamera")
public class PatrolCamera extends Plugin {
    private static final float MAX_ZOOM = 10f;
    private static final int SLIDER_STEPS = 1000;
    private static final long STATS_INTERVAL_MS = 30_000;

    private FrameLayout panel;
    private ProcessCameraProvider provider;
    private TextRecognizer reader;
    private ToneGenerator tone;
    private String session;
    private final Map<String,Long> lastSeen = new HashMap<>();
    private final Set<String> emitted = new HashSet<>();
    /** Captured plates and when a reading of them (or of a variant) was last seen. */
    private final Map<String,Long> recent = new HashMap<>();
    private final Set<String> variantsReported = new HashSet<>();
    /** Plate guide as fractions of the screen: left, top, right, bottom. Set by fitGuide. */
    private final float[] guideNorm = {0.09f,0.4f,0.91f,0.6f};
    private OnBackPressedCallback backCallback;

    private Camera camera;
    private View guide, flash;
    private LinearLayout topBar, controls, sliderRow;
    private SeekBar slider;
    private TextView zoomLabel, status;
    private Button zoomButton, modeButton;
    private final List<Float> presets = new ArrayList<>();
    private float zoomMin = 1f, zoomMax = 1f, initialZoom = 1f, currentZoom = 1f;
    private boolean zoomReady, multi = true, diagnostics, shutterRequested;
    private String patrolMode = "walking";
    private int captures;

    // Diagnostics counters, reported every STATS_INTERVAL_MS while diagnostics are on.
    private long statsSince, ocrMsTotal;
    private int framesSeen, framesRead, linesSeen, plateLines, frameWidth, frameHeight, cropWidth, cropHeight;
    private int outsideGuide, notPlate, variants;
    /** A reading similar to a capture within this time (since it was last seen) is the same vehicle. */
    private static final long VARIANT_WINDOW_WALKING_MS = 8_000, VARIANT_WINDOW_VEHICLE_MS = 4_000;

    /* ───────────── Lifecycle ───────────── */

    @PluginMethod public void start(PluginCall call) {
        // CameraX needs the runtime permission; the WebView camera normally obtains it first,
        // but fail clearly rather than with an opaque bind error if it was revoked.
        if (ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            call.reject("Camera permission is required for patrol mode. Allow it in Android settings.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (panel != null) { call.reject("Patrol already active"); return; }
            patrolMode = "vehicle".equals(call.getString("mode")) ? "vehicle" : "walking";
            boolean vehicle = "vehicle".equals(patrolMode);
            multi = !"single".equals(call.getString("captureMode","multi"));
            diagnostics = Boolean.TRUE.equals(call.getBoolean("diagnostics",false));
            initialZoom = call.getDouble("zoom",1.0).floatValue();
            presets.clear();
            JSArray requested = call.getArray("presets");
            if (requested != null) for (int i=0;i<requested.length();i++) presets.add((float)requested.optDouble(i,1));
            if (presets.isEmpty()) presets.addAll(Arrays.asList(1f,1.75f,3.5f,5f));
            Collections.sort(presets);
            captures = 0;
            resetStats();
            session = UUID.randomUUID().toString();
            String current = session;
            try {
                reader = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION,70);
                buildScreen();
                getActivity().addContentView(panel,new ViewGroup.LayoutParams(-1,-1));
                ViewCompat.requestApplyInsets(panel);
                // Android Back (button or gesture) leaves patrol, same as the Exit button.
                backCallback = new OnBackPressedCallback(true) {
                    @Override public void handleOnBackPressed() { finish(); }
                };
                getActivity().getOnBackPressedDispatcher().addCallback(getActivity(),backCallback);
                var future = ProcessCameraProvider.getInstance(getContext());
                var main = ContextCompat.getMainExecutor(getContext());
                future.addListener(() -> {
                    if (!current.equals(session)) {call.reject("Patrol ended");return;}
                    try {
                        provider = future.get();
                        Preview feed = new Preview.Builder().build();
                        feed.setSurfaceProvider(((PreviewView)panel.getChildAt(0)).getSurfaceProvider());
                        ImageAnalysis analysis = new ImageAnalysis.Builder().setTargetResolution(new Size(1920,1080))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                        analysis.setAnalyzer(main,frame -> analyze(frame,current,vehicle));
                        // One ViewPort for both use cases: each analysis frame then carries a crop
                        // rect matching what the preview shows. Without it the square analysis frame
                        // saw well beyond the screen edges and read sign text the officer never saw.
                        UseCaseGroup group = new UseCaseGroup.Builder().setViewPort(viewPort())
                            .addUseCase(feed).addUseCase(analysis).build();
                        camera = provider.bindToLifecycle(getActivity(),CameraSelector.DEFAULT_BACK_CAMERA,group);
                        zoomReady = false;
                        camera.getCameraInfo().getZoomState().observe(getActivity(),this::onZoomState);
                        applyPlateFocus();
                        call.resolve();
                    } catch(Exception e) {finish();call.reject("Camera unavailable",e);}
                },main);
            } catch(Exception e) {finish();call.reject("Patrol failed",e);}
        });
    }

    @PluginMethod public void stop(PluginCall call) {getActivity().runOnUiThread(() -> {finish();call.resolve();});}

    private void finish() {
        if(panel==null)return;
        session=null;
        if(diagnostics) emitStats();
        if(backCallback!=null){backCallback.remove();backCallback=null;}
        if(camera!=null)camera.getCameraInfo().getZoomState().removeObservers(getActivity());
        if(provider!=null)provider.unbindAll();
        camera=null;guide=null;flash=null;topBar=null;controls=null;sliderRow=null;slider=null;
        zoomLabel=null;status=null;zoomButton=null;modeButton=null;
        if(reader!=null)reader.close();
        if(tone!=null){tone.release();tone=null;}
        ((ViewGroup)panel.getParent()).removeView(panel);
        panel=null;lastSeen.clear();emitted.clear();recent.clear();variantsReported.clear();shutterRequested=false;
        notifyListeners("finished",new JSObject());
    }
    @Override protected void handleOnDestroy(){finish();}

    /* ───────────── Screen ───────────── */

    private float dp(float v) { return v*getContext().getResources().getDisplayMetrics().density; }

    private Button button(String text,String description) {
        Button b = new Button(getContext());
        b.setAllCaps(false);
        b.setText(text);
        b.setTextColor(Color.WHITE);
        b.setContentDescription(description);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xCC1F2937);
        bg.setStroke((int)dp(1),0x80FFFFFF);
        bg.setCornerRadius(dp(24));
        b.setBackground(bg);
        b.setMinHeight((int)dp(48));
        b.setMinWidth((int)dp(72));
        b.setPadding((int)dp(14),0,(int)dp(14),0);
        return b;
    }

    private void buildScreen() {
        Context ctx = getContext();
        panel = new FrameLayout(ctx);
        panel.setBackgroundColor(Color.BLACK);
        panel.addView(new PreviewView(ctx)); // child 0: camera feed

        // Plate guide: same 3:1 box as the scan screen. Focus and exposure are measured inside it.
        guide = new View(ctx);
        GradientDrawable border = new GradientDrawable();
        border.setStroke((int)dp(3),Color.parseColor("#4FD1C5"));
        border.setCornerRadius(dp(12));
        guide.setBackground(border);
        guide.setContentDescription("Plate capture area");
        panel.addView(guide,new FrameLayout.LayoutParams(0,0,Gravity.CENTER));
        var metrics = ctx.getResources().getDisplayMetrics();
        fitGuide(metrics.widthPixels,metrics.heightPixels);

        // Capture confirmation: a brief white flash over the feed.
        flash = new View(ctx);
        flash.setBackgroundColor(Color.WHITE);
        flash.setAlpha(0f);
        flash.setClickable(false);
        panel.addView(flash,new FrameLayout.LayoutParams(-1,-1));

        // Top bar: Exit, title, capture count and diagnostics indicator.
        topBar = new LinearLayout(ctx);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setBackgroundColor(0x99000000);
        Button exit = button("✕  Exit","Exit patrol and review captures");
        exit.setOnClickListener(v -> finish());
        topBar.addView(exit,new LinearLayout.LayoutParams(-2,-2));
        status = new TextView(ctx);
        status.setTextColor(Color.WHITE);
        status.setTextSize(15);
        status.setPadding((int)dp(12),0,0,0);
        topBar.addView(status,new LinearLayout.LayoutParams(0,-2,1f));
        panel.addView(topBar,new FrameLayout.LayoutParams(-1,-2,Gravity.TOP));

        // Bottom controls: optional zoom slider, then zoom | shutter | capture mode.
        controls = new LinearLayout(ctx);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setBackgroundColor(0x99000000);

        sliderRow = new LinearLayout(ctx);
        sliderRow.setGravity(Gravity.CENTER_VERTICAL);
        sliderRow.setVisibility(View.GONE);
        zoomLabel = new TextView(ctx);
        zoomLabel.setTextColor(Color.WHITE);
        zoomLabel.setMinWidth((int)dp(56));
        slider = new SeekBar(ctx);
        slider.setMax(SLIDER_STEPS);
        slider.setContentDescription("Zoom");
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s,int p,boolean fromUser) { if (fromUser) setZoom(progressToZoom(p),false); }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) { setZoom(progressToZoom(s.getProgress()),true); }
        });
        sliderRow.addView(zoomLabel,new LinearLayout.LayoutParams(-2,-2));
        sliderRow.addView(slider,new LinearLayout.LayoutParams(0,-2,1f));
        controls.addView(sliderRow,new LinearLayout.LayoutParams(-1,(int)dp(48)));

        LinearLayout row = new LinearLayout(ctx);
        row.setGravity(Gravity.CENTER_VERTICAL);
        zoomButton = button("1×","Zoom. Tap for the next zoom step, long-press for a custom zoom.");
        zoomButton.setOnClickListener(v -> { sliderRow.setVisibility(View.GONE); setZoom(nextPreset(currentZoom),true); });
        zoomButton.setOnLongClickListener(v -> {
            sliderRow.setVisibility(sliderRow.getVisibility()==View.VISIBLE ? View.GONE : View.VISIBLE);
            return true; // consumes the press so the zoom does not also step
        });
        row.addView(zoomButton,new LinearLayout.LayoutParams(0,-2,1f));

        Button shutter = new Button(ctx);
        shutter.setContentDescription("Capture number plate");
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(Color.WHITE);
        ring.setStroke((int)dp(5),0xFF9CA3AF);
        shutter.setBackground(ring);
        shutter.setOnClickListener(v -> shutterRequested = true);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams((int)dp(76),(int)dp(76));
        sp.setMargins((int)dp(16),0,(int)dp(16),0);
        row.addView(shutter,sp);

        modeButton = button("","Capture mode. Tap to switch between Multi and Single.");
        modeButton.setOnClickListener(v -> { multi = !multi; emitted.clear(); lastSeen.clear(); recent.clear(); variantsReported.clear(); showStatus(); });
        row.addView(modeButton,new LinearLayout.LayoutParams(0,-2,1f));
        controls.addView(row,new LinearLayout.LayoutParams(-1,-2));
        panel.addView(controls,new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM));

        // Capacitor draws edge to edge and only pads the web page. Keep these controls clear of
        // the status bar, the navigation bar and any display cutout.
        ViewCompat.setOnApplyWindowInsetsListener(panel,(v,insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
            int pad = (int)dp(8);
            topBar.setPadding(bars.left+pad,bars.top+pad,bars.right+pad,pad);
            controls.setPadding(bars.left+pad,pad,bars.right+pad,bars.bottom+pad);
            return insets;
        });
        // Rotation keeps this activity (configChanges), so re-fit the guide and the focus region.
        panel.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob) -> {
            if (r-l!=or-ol || b-t!=ob-ot) { fitGuide(r-l,b-t); applyPlateFocus(); }
        });
        showStatus();
    }

    private void showStatus() {
        if (status==null) return;
        String title = "vehicle".equals(patrolMode) ? "Vehicle patrol" : "Walking patrol";
        status.setText(title+" · "+(multi ? "Multi" : "Single")+"\nCaptured "+captures+(diagnostics ? "   ● DIAG" : ""));
        modeButton.setText(multi ? "Multi" : "Single");
    }

    /** Same 3:1 box as the scan screen: 82% of the width, at most 576 dp wide. */
    private void fitGuide(int width,int height) {
        if (guide==null || width<=0 || height<=0) return;
        int w = (int)Math.min(width*0.82f,dp(576));
        FrameLayout.LayoutParams p = (FrameLayout.LayoutParams)guide.getLayoutParams();
        p.width = w; p.height = w/3;
        guide.setLayoutParams(p);
        // The guide is centred (Gravity.CENTER) on the full-screen preview.
        guideNorm[0] = (width-w)/2f/width; guideNorm[2] = (width+w)/2f/width;
        guideNorm[1] = (height-w/3f)/2f/height; guideNorm[3] = (height+w/3f)/2f/height;
    }

    /** The preview's visible area (FILL_CENTER, like PreviewView), shared with the analysis use case. */
    private ViewPort viewPort() {
        PreviewView view = (PreviewView)panel.getChildAt(0);
        ViewPort port = view.getViewPort();
        if (port!=null) return port;
        // Not laid out yet: the panel fills the screen, so use the display size.
        var metrics = getContext().getResources().getDisplayMetrics();
        int rotation = panel.getDisplay()!=null ? panel.getDisplay().getRotation() : Surface.ROTATION_0;
        return new ViewPort.Builder(new Rational(metrics.widthPixels,metrics.heightPixels),rotation).build();
    }

    /** The part of the frame shown on screen, in upright image coordinates (as ML Kit reports boxes). */
    private static Rect visibleRect(ImageProxy frame,int rotation) {
        Rect c = frame.getCropRect();
        int w = frame.getWidth(), h = frame.getHeight();
        switch (rotation) {
            case 90: return new Rect(h-c.bottom,c.left,h-c.top,c.right);
            case 180: return new Rect(w-c.right,h-c.bottom,w-c.left,h-c.top);
            case 270: return new Rect(c.top,w-c.right,c.bottom,w-c.left);
            default: return new Rect(c);
        }
    }

    /** The plate guide in upright image coordinates, grown by the given fractions of its size. */
    private Rect guideRect(Rect visible,float growX,float growY) {
        float l = guideNorm[0], t = guideNorm[1], r = guideNorm[2], b = guideNorm[3];
        float gx = (r-l)*growX, gy = (b-t)*growY;
        return new Rect(
            visible.left+Math.round(Math.max(0f,l-gx)*visible.width()),
            visible.top+Math.round(Math.max(0f,t-gy)*visible.height()),
            visible.left+Math.round(Math.min(1f,r+gx)*visible.width()),
            visible.top+Math.round(Math.min(1f,b+gy)*visible.height()));
    }

    private void confirmCapture() {
        captures++;
        showStatus();
        if (flash!=null) {
            flash.animate().cancel();
            flash.setAlpha(0.85f);
            flash.animate().alpha(0f).setDuration(220).start();
        }
        if (panel!=null) panel.performHapticFeedback(Build.VERSION.SDK_INT>=30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY);
    }

    /* ───────────── Recognition ───────────── */

    private static String plateText(Text.Line line) {
        return line.getText().toUpperCase(Locale.ROOT).replaceAll("[ -]","");
    }

    private static boolean plateShaped(Text.Line line) {
        Rect box = line.getBoundingBox();
        return box!=null && plateText(line).matches("[A-Z0-9]{2,8}") && box.width()>=1.4*box.height();
    }

    private boolean recentlyCaptured(String plate,long now,boolean vehicle) {
        long window = vehicle ? VARIANT_WINDOW_VEHICLE_MS : VARIANT_WINDOW_WALKING_MS;
        for (Map.Entry<String,Long> e:recent.entrySet()) {
            if (now-e.getValue()>window || !PlateRules.variant(e.getKey(),plate)) continue;
            e.setValue(now);
            if (!e.getKey().equals(plate) && variantsReported.add(e.getKey()+"|"+plate)) {
                variants++;
                JSObject event = new JSObject();
                event.put("plate",e.getKey()); event.put("variant",plate);
                notifyListeners("variant",event);
            }
            return true;
        }
        return false;
    }

    /** Drop stale entries so the maps stay small on a long patrol. */
    private void prune(long now) {
        if (lastSeen.size()<200 && recent.size()<200) return;
        lastSeen.values().removeIf(t -> now-t>10_000);
        recent.values().removeIf(t -> now-t>60_000);
        emitted.retainAll(lastSeen.keySet());
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyze(ImageProxy frame,String current,boolean vehicle) {
        if (!current.equals(session) || frame.getImage()==null) {frame.close();return;}
        framesSeen++;
        if (frameWidth==0) {
            boolean upright = frame.getImageInfo().getRotationDegrees()%180==0;
            frameWidth = upright ? frame.getWidth() : frame.getHeight();
            frameHeight = upright ? frame.getHeight() : frame.getWidth();
        }
        if (diagnostics && SystemClock.elapsedRealtime()-statsSince>=STATS_INTERVAL_MS) emitStats();
        boolean manual = shutterRequested;
        // Single mode reads nothing until the shutter is pressed: no continuous OCR load.
        if (!multi && !manual) {frame.close();return;}
        shutterRequested = false;
        framesRead++;
        int rotation = frame.getImageInfo().getRotationDegrees();
        long at = System.currentTimeMillis();
        long t0 = SystemClock.elapsedRealtime();
        Rect visible = visibleRect(frame,rotation);
        if (cropWidth==0) { cropWidth = visible.width(); cropHeight = visible.height(); }
        // Walking: the officer aims the plate into the guide; allow some slack around it.
        // Vehicle: plates pass anywhere across the screen, so the whole visible area counts.
        Rect zone = vehicle ? visible : guideRect(visible,0.05f,0.5f);
        InputImage image = InputImage.fromMediaImage(frame.getImage(),rotation);
        reader.process(image).addOnSuccessListener(result -> {
            ocrMsTotal += SystemClock.elapsedRealtime()-t0;
            if (!current.equals(session)) return;
            if (manual) { captureManual(frame,rotation,at,result,visible); return; }
            Set<String> seen = new HashSet<>();
            long now = SystemClock.elapsedRealtime();
            prune(now);
            for (Text.TextBlock block:result.getTextBlocks()) for (Text.Line line:block.getLines()) {
                linesSeen++;
                if (!plateShaped(line)) continue;
                Rect box = line.getBoundingBox();
                if (!zone.contains(box.centerX(),box.centerY())) {outsideGuide++;continue;}
                String raw = plateText(line);
                String plate = PlateRules.canonical(raw);
                if (!PlateRules.autoCapture(plate)) {notPlate++;continue;}
                plateLines++;
                if (!seen.add(plate)) continue;
                if (recentlyCaptured(plate,now,vehicle)) continue;
                Long previous = lastSeen.put(plate,now);
                // A plate must be read in two frames close together before it is captured.
                if (previous==null || now-previous>(vehicle?900:1500)) {emitted.remove(plate);continue;}
                if (emitted.contains(plate)) continue;
                emitted.add(plate);
                recent.put(plate,now);
                if (!emitSighting(frame,rotation,at,plate,raw,box,visible,false)) {finish();break;}
            }
        }).addOnFailureListener(e -> {
            if (manual && current.equals(session)) captureManual(frame,rotation,at,null,visible);
        }).addOnCompleteListener(task -> frame.close());
    }

    /**
     * Shutter press: always capture the frame, with the plate-shaped line nearest the guide if one
     * was read on screen. Any text counts here (the officer chose the moment), including all-letter
     * personalised plates that Multi does not capture on its own.
     */
    private void captureManual(ImageProxy frame,int rotation,long at,Text result,Rect visible) {
        Rect guideBox = guideRect(visible,0f,0f);
        Text.Line best = null;
        double bestScore = Double.MAX_VALUE;
        if (result!=null) for (Text.TextBlock block:result.getTextBlocks()) for (Text.Line line:block.getLines()) {
            if (!plateShaped(line)) continue;
            Rect b = line.getBoundingBox();
            if (!visible.contains(b.centerX(),b.centerY())) continue;
            double dx = b.exactCenterX()-guideBox.exactCenterX(), dy = b.exactCenterY()-guideBox.exactCenterY();
            // Prefer the line nearest the guide; larger text breaks near-ties; plate formats win.
            double score = Math.hypot(dx,dy)-b.height()-(PlateRules.autoCapture(PlateRules.canonical(plateText(line))) ? guideBox.height() : 0);
            if (score<bestScore) {bestScore=score;best=line;}
        }
        String raw = best!=null ? plateText(best) : "";
        Rect box = best!=null ? best.getBoundingBox() : guideBox;
        if (!emitSighting(frame,rotation,at,PlateRules.canonical(raw),raw,box,visible,true)) finish();
    }

    /**
     * Save the frame as the officer saw it (cropped to the visible area) and report the plate box
     * relative to that saved image.
     */
    private boolean emitSighting(ImageProxy frame,int rotation,long at,String plate,String rawText,Rect plateBox,Rect visible,boolean manual) {
        try {
            Bitmap raw = frame.toBitmap();
            Matrix m = new Matrix(); m.postRotate(rotation);
            Bitmap upright = Bitmap.createBitmap(raw,0,0,raw.getWidth(),raw.getHeight(),m,true);
            // raw is in buffer orientation, like frame.getWidth()/getHeight().
            boolean full = raw.getWidth()==frame.getWidth() && raw.getHeight()==frame.getHeight();
            Rect v = new Rect(visible);
            // toBitmap() may or may not apply the crop rect; only crop when it returned the full frame.
            if (full && v.intersect(0,0,upright.getWidth(),upright.getHeight()) && (v.width()<upright.getWidth() || v.height()<upright.getHeight()))
                upright = Bitmap.createBitmap(upright,v.left,v.top,v.width(),v.height());
            Rect box = new Rect(plateBox);
            box.offset(-visible.left,-visible.top);
            if (!box.intersect(0,0,upright.getWidth(),upright.getHeight())) box.set(0,0,upright.getWidth(),upright.getHeight());
            File path = File.createTempFile("patrol-", ".jpg",getContext().getCacheDir());
            try(FileOutputStream out = new FileOutputStream(path)) {upright.compress(Bitmap.CompressFormat.JPEG,88,out);}
            JSObject event = new JSObject();
            event.put("plate",plate); event.put("raw",rawText); event.put("at",at); event.put("path",path.getAbsolutePath());
            event.put("x",box.left);event.put("y",box.top);event.put("width",box.width());event.put("height",box.height());
            event.put("manual",manual); event.put("zoom",(double)currentZoom);
            event.put("captureMode",multi ? "multi" : "single");
            notifyListeners("sighting",event);
            confirmCapture();
            return true;
        } catch(Exception error) { return false; }
    }

    /**
     * Read text in a still image (the default scan camera's capture) with ML Kit.
     * Returns every recognised line with its box, in image pixels.
     */
    @PluginMethod public void readText(PluginCall call) {
        String data = call.getString("image","");
        Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(data.substring(data.indexOf(',')+1),Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes,0,bytes.length);
        } catch(Exception e) { call.reject("Image could not be decoded",e); return; }
        if (bitmap==null) { call.reject("Image could not be decoded"); return; }
        TextRecognizer still = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        long t0 = SystemClock.elapsedRealtime();
        int width = bitmap.getWidth(), height = bitmap.getHeight();
        still.process(InputImage.fromBitmap(bitmap,0)).addOnSuccessListener(result -> {
            JSArray lines = new JSArray();
            for (Text.TextBlock block:result.getTextBlocks()) for (Text.Line line:block.getLines()) {
                Rect b = line.getBoundingBox();
                if (b==null) continue;
                JSObject l = new JSObject();
                l.put("text",line.getText());
                l.put("x",b.left); l.put("y",b.top); l.put("width",b.width()); l.put("height",b.height());
                lines.put(l);
            }
            JSObject out = new JSObject();
            out.put("lines",lines); out.put("width",width); out.put("height",height);
            out.put("durationMs",SystemClock.elapsedRealtime()-t0);
            call.resolve(out);
        }).addOnFailureListener(e -> call.reject("Text recognition failed",e))
          .addOnCompleteListener(task -> still.close());
    }

    /* ───────────── Plate focus ───────────── */

    /**
     * Keep continuous autofocus and auto-exposure, but only measure inside the plate guide,
     * so the lens tracks the plate as distance changes instead of hunting onto passing
     * objects or the background. A fixed focus lock would blur as soon as the officer moved.
     */
    @OptIn(markerClass=ExperimentalCamera2Interop.class)
    private void applyPlateFocus() {
        if (camera==null || panel==null || guide==null) return;
        try {
            Camera2CameraInfo info = Camera2CameraInfo.from(camera.getCameraInfo());
            Rect active = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            if (active==null || panel.getWidth()==0 || panel.getHeight()==0) return;
            float fw = Math.min(1f,guide.getLayoutParams().width/(float)panel.getWidth());
            float fh = Math.min(1f,guide.getLayoutParams().height/(float)panel.getHeight());
            int displayRotation = panel.getDisplay()!=null ? panel.getDisplay().getRotation() : Surface.ROTATION_0;
            int sensor = camera.getCameraInfo().getSensorRotationDegrees(displayRotation);
            // The sensor is landscape: when the screen is rotated against it, screen width runs along sensor height.
            float sx = sensor%180==0 ? fw : fh, sy = sensor%180==0 ? fh : fw;
            int rw = (int)(active.width()*sx), rh = (int)(active.height()*sy);
            MeteringRectangle region = new MeteringRectangle((active.width()-rw)/2,(active.height()-rh)/2,rw,rh,MeteringRectangle.METERING_WEIGHT_MAX);
            CaptureRequestOptions.Builder options = new CaptureRequestOptions.Builder();
            int[] afModes = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (afModes!=null) for (int mode:afModes) if (mode==CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                options.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            Integer maxAf = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
            Integer maxAe = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
            if (maxAf!=null && maxAf>0) options.setCaptureRequestOption(CaptureRequest.CONTROL_AF_REGIONS,new MeteringRectangle[]{region});
            if (maxAe!=null && maxAe>0) options.setCaptureRequestOption(CaptureRequest.CONTROL_AE_REGIONS,new MeteringRectangle[]{region});
            Camera2CameraControl.from(camera.getCameraControl()).setCaptureRequestOptions(options.build());
        } catch (Exception ignored) {
            // Focus regions are an improvement only; the camera keeps CameraX's default focus.
        }
    }

    /* ───────────── Zoom ───────────── */

    private void onZoomState(ZoomState state) {
        if (state==null || panel==null) return;
        zoomMin = state.getMinZoomRatio();
        zoomMax = Math.max(zoomMin,Math.min(state.getMaxZoomRatio(),MAX_ZOOM));
        if (!zoomReady) {
            zoomReady = true;
            if (diagnostics) {
                JSObject e = new JSObject();
                e.put("zoomMin",(double)zoomMin); e.put("zoomMax",(double)state.getMaxZoomRatio());
                notifyListeners("camera",e);
            }
            setZoom(initialZoom,false);
            return;
        }
        showZoom(state.getZoomRatio());
    }

    /** Next preset above the current zoom, wrapping to the lowest reachable preset (mirrors src/lib/zoom.ts). */
    private float nextPreset(float z) {
        Float lowest = null;
        for (float p:presets) {
            if (p<zoomMin-1e-3f || p>zoomMax+1e-3f) continue;
            if (lowest==null) lowest = p;
            if (p>z+0.01f) return p;
        }
        return lowest!=null ? lowest : zoomMin;
    }

    private float progressToZoom(int progress) { return zoomMin+(zoomMax-zoomMin)*progress/(float)SLIDER_STEPS; }

    private void setZoom(float requested,boolean persist) {
        if (camera==null) return;
        float z = Float.isNaN(requested) ? zoomMin : Math.max(zoomMin,Math.min(zoomMax,requested));
        camera.getCameraControl().setZoomRatio(z);
        showZoom(z);
        if (persist) {
            JSObject event = new JSObject();
            event.put("ratio",(double)z);
            notifyListeners("zoom",event);
        }
    }

    private void showZoom(float z) {
        currentZoom = z;
        if (zoomLabel==null) return;
        zoomLabel.setText(formatZoom(z));
        zoomButton.setText(formatZoom(z));
        if (!slider.isPressed() && zoomMax>zoomMin) slider.setProgress(Math.round((z-zoomMin)/(zoomMax-zoomMin)*SLIDER_STEPS));
    }

    private static String formatZoom(float z) {
        String s = String.format(Locale.ROOT,"%.2f",z).replaceAll("0+$","").replaceAll("\\.$","");
        return s+"×";
    }

    /* ───────────── Device status and diagnostics ───────────── */

    private void resetStats() {
        statsSince = SystemClock.elapsedRealtime();
        framesSeen = framesRead = linesSeen = plateLines = 0;
        outsideGuide = notPlate = variants = 0;
        ocrMsTotal = 0;
        frameWidth = frameHeight = cropWidth = cropHeight = 0;
    }

    private JSObject deviceStatusObject() {
        JSObject s = new JSObject();
        try {
            BatteryManager bm = (BatteryManager)getContext().getSystemService(Context.BATTERY_SERVICE);
            s.put("battery",bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
            Intent b = getContext().registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            int plugged = b!=null ? b.getIntExtra(BatteryManager.EXTRA_PLUGGED,0) : 0;
            s.put("charging",plugged!=0);
            if (b!=null) s.put("batteryTempC",b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE,0)/10.0);
        } catch(Exception ignored) {}
        if (Build.VERSION.SDK_INT>=29) {
            PowerManager pm = (PowerManager)getContext().getSystemService(Context.POWER_SERVICE);
            // 0 none, 1 light, 2 moderate, 3 severe, 4 critical, 5 emergency, 6 shutdown
            s.put("thermal",pm.getCurrentThermalStatus());
        }
        return s;
    }

    /** Battery level, charging state, battery temperature and thermal status. */
    @PluginMethod public void deviceStatus(PluginCall call) { call.resolve(deviceStatusObject()); }

    private void emitStats() {
        long now = SystemClock.elapsedRealtime();
        double minutes = Math.max(1,now-statsSince)/60000.0;
        JSObject e = deviceStatusObject();
        e.put("patrolMode",patrolMode); e.put("captureMode",multi ? "multi" : "single");
        e.put("seconds",(now-statsSince)/1000.0);
        e.put("framesPerMinute",framesSeen/minutes); e.put("readsPerMinute",framesRead/minutes);
        e.put("ocrMsAvg",framesRead>0 ? ocrMsTotal/(double)framesRead : 0);
        e.put("lines",linesSeen); e.put("plateLines",plateLines); e.put("captures",captures);
        e.put("zoom",(double)currentZoom); e.put("zoomMin",(double)zoomMin); e.put("zoomMax",(double)zoomMax);
        e.put("frameWidth",frameWidth); e.put("frameHeight",frameHeight);
        e.put("cropWidth",cropWidth); e.put("cropHeight",cropHeight);
        e.put("outsideGuide",outsideGuide); e.put("notPlate",notPlate); e.put("variants",variants);
        notifyListeners("stats",e);
        int w = frameWidth, h = frameHeight, cw = cropWidth, ch = cropHeight;
        resetStats();
        frameWidth = w; frameHeight = h; cropWidth = cw; cropHeight = ch;
    }

    /* ───────────── Misc ───────────── */

    @PluginMethod public void alert(PluginCall call) {
        if(tone!=null) tone.startTone(ToneGenerator.TONE_PROP_BEEP,180);
        call.resolve();
    }
    @PluginMethod public void release(PluginCall call) {
        String path = call.getString("path","");
        File f = new File(path);
        if (getContext().getCacheDir().equals(f.getParentFile()) && f.getName().startsWith("patrol-")) f.delete();
        call.resolve();
    }
}
