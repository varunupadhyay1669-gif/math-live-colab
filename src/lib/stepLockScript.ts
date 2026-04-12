/**
 * Step Lock Script — injected into the simulation iframe.
 * Hides/shows elements based on their `data-step` attribute.
 * 
 * HTML authors mark elements with data-step="1", data-step="2", etc.
 * The teacher controls which step is currently visible.
 */
export const stepLockScript = `
<script>
(function() {
  let currentStep = 999; // Show all by default (no step-lock until teacher activates)
  let maxStep = 0;
  
  function updateSteps() {
    const elements = document.querySelectorAll('[data-step]');
    maxStep = 0;
    
    elements.forEach(function(el) {
      var step = parseInt(el.getAttribute('data-step'), 10);
      if (isNaN(step)) return;
      if (step > maxStep) maxStep = step;
      
      if (step <= currentStep) {
        el.style.display = '';
        el.style.opacity = '1';
        el.style.pointerEvents = '';
        el.style.transition = 'opacity 0.4s ease';
      } else {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        // Use timeout to set display:none after fade
        setTimeout(function() {
          if (parseInt(el.getAttribute('data-step'), 10) > currentStep) {
            el.style.display = 'none';
          }
        }, 400);
      }
    });
    
    // Report max step to parent
    window.parent.postMessage({ type: 'STEP_INFO', maxStep: maxStep, currentStep: currentStep }, '*');
  }
  
  // Listen for step changes from parent
  window.addEventListener('message', function(e) {
    var data = e.data;
    if (!data || !data.type) return;
    
    if (data.type === 'SET_STEP') {
      currentStep = data.step;
      updateSteps();
    }
    if (data.type === 'GET_MAX_STEP') {
      updateSteps();
    }
    if (data.type === 'DISABLE_STEP_LOCK') {
      currentStep = 999;
      updateSteps();
    }
  });
  
  // Initial scan after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(updateSteps, 100); });
  } else {
    setTimeout(updateSteps, 100);
  }
})();
</script>
`;
